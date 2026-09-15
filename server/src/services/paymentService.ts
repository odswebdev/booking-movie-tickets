import { hash as argonHash, argon2id, verify as argonVerify } from "argon2";
import {
  createPaymentIntentSchema,
  decryptedCardSchema,
  verifyPaymentSchema,
} from "../../../shared/schemas.js";
import { SMS_CODE_LENGTH, SMS_CODE_TTL_SECONDS, SMS_MAX_ATTEMPTS } from "../../../shared/pricing.js";
import type { Booking, CardBrand, PaymentIntent, PaymentMethod } from "../../../shared/types.js";
import { getRepositories } from "../db/provider.js";
import type { StoredBooking, StoredOtpCode, StoredPayment } from "../db/schema.js";
import { dispatchSmsCode } from "../queues/queueService.js";
import { createRateLimiter, type RateLimiter } from "../redis/rateLimit.js";
import { env } from "../config/env.js";
import { ApiError } from "../utils/errors.js";
import { newId, randomOtp } from "../utils/ids.js";
import { cardExpiryValid, cardLast4, detectCardBrand, luhnValid } from "../utils/crypto.js";
import { confirmBooking, findStoredBooking, recordPayment, toBooking } from "./bookingService.js";
import { getPaymentKeyPair } from "./cryptoService.js";
import { maskPhoneForDisplay, normalizePhone } from "./smsService.js";
import { providerByName, providerForMethod } from "./payments/factory.js";
import { audit } from "./auditService.js";
import { ProviderChargeError, type ChargeMethodData, type PaymentProvider } from "./payments/types.js";
import { paymentsInFlight, recordPaymentOutcome, smsQuotaHits } from "../utils/metrics.js";

/** Test cards: everything except the happy-path number is declined. */
const DECLINED_CARDS = new Set(["4000000000000002", "4000056655665556"]);
const PAYPAL_DECLINE_MARKER = "decline@";

/**
 * Abuse cap: max N confirmation SMS per phone number per hour (ТЗ: 5).
 * Created lazily — the Redis connection only exists after initDatabase().
 */
let smsQuota: RateLimiter | null = null;

function smsQuotaLimiter(): RateLimiter {
  if (!smsQuota) {
    smsQuota = createRateLimiter({ prefix: "sms:rl", max: env.SMS_MAX_PER_HOUR, windowSeconds: 3600 });
  }
  return smsQuota;
}

async function assertSmsQuota(phone: string): Promise<void> {
  const decision = await smsQuotaLimiter().check(phone);
  if (!decision.allowed) {
    smsQuotaHits.inc({});
    throw ApiError.rateLimited("Too many codes sent to this number. Please try again later.", {
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }
}

/**
 * Demo SMS codes (non-production only): echoed back as `devCode` so the flow
 * can be completed without a real gateway. Memory-only — never persisted.
 */
const devCodes = new Map<string, { code: string; expiresAt: number }>();

function rememberDevCode(paymentId: string, code: string, expiresAt: number): void {
  if (env.isProduction) return;
  devCodes.set(paymentId, { code, expiresAt });
}

function takeDevCode(paymentId: string): string | undefined {
  const entry = devCodes.get(paymentId);
  if (entry && entry.expiresAt > Date.now()) return entry.code;
  devCodes.delete(paymentId);
  return undefined;
}

function dropDevCode(paymentId: string): void {
  devCodes.delete(paymentId);
}

/**
 * Card details validated at intent time, held for the charge at verify time.
 *
 * Memory-only by design: the full PAN is never written to disk or logs.
 * Entries die with the intent (charge done / failed-terminal / expired) and
 * are swept lazily. Single-instance only — the Redis migration (roadmap)
 * replaces this with an encrypted, TTL-ed entry.
 */
interface PendingCard {
  number: string;
  expiryMonth: string;
  expiryYear: string;
  cvc: string;
  holder: string;
  expiresAt: number;
}

const pendingCards = new Map<string, PendingCard>();

/**
 * Tokens produced by the PCI widgets (Checkout.js / Stripe Elements) held
 * until the SMS code is verified. Tokens are not card data, but they are still
 * short-lived and memory-only: they die with the intent.
 */
interface PendingToken {
  provider: "yookassa" | "stripe";
  token: string;
  wallet?: "apple_pay" | "google_pay";
  expiresAt: number;
}

const pendingTokens = new Map<string, PendingToken>();
const MAX_PENDING_CARDS = 1000;

function rememberToken(paymentId: string, token: PendingToken): void {
  pendingTokens.set(paymentId, token);
}

function takeToken(paymentId: string): PendingToken | null {
  const token = pendingTokens.get(paymentId) ?? null;
  if (token && token.expiresAt > Date.now()) return token;
  pendingTokens.delete(paymentId);
  return null;
}

function dropToken(paymentId: string): void {
  pendingTokens.delete(paymentId);
}

function rememberCard(paymentId: string, card: Omit<PendingCard, "expiresAt">, expiresAt: number): void {
  if (pendingCards.size >= MAX_PENDING_CARDS) {
    // Defensive cap: drop the oldest entries first.
    const overflow = pendingCards.size - MAX_PENDING_CARDS + 1;
    let dropped = 0;
    for (const key of pendingCards.keys()) {
      if (dropped >= overflow) break;
      pendingCards.delete(key);
      dropped += 1;
    }
  }
  pendingCards.set(paymentId, { ...card, expiresAt });
  sweepPendingCards();
}

function takeCard(paymentId: string): PendingCard | null {
  const card = pendingCards.get(paymentId) ?? null;
  if (card && card.expiresAt > Date.now()) return card;
  pendingCards.delete(paymentId);
  return null;
}

function dropCard(paymentId: string): void {
  pendingCards.delete(paymentId);
}

function sweepPendingCards(now: number = Date.now()): void {
  for (const [id, card] of pendingCards) {
    if (card.expiresAt <= now) pendingCards.delete(id);
  }
}

function toIntent(stored: StoredPayment): PaymentIntent {
  const intent: PaymentIntent = {
    id: stored.id,
    bookingId: stored.bookingId,
    status: stored.status,
    provider: stored.provider ?? "mock",
    method: stored.method,
    amountCents: stored.amountCents,
    currency: stored.currency,
    cardBrand: stored.method === "card" ? stored.cardBrand : null,
    cardLast4: stored.method === "card" ? stored.cardLast4 : null,
    phoneMasked: maskPhoneForDisplay(stored.phone),
    codeLength: SMS_CODE_LENGTH,
    expiresAt: stored.expiresAt,
    attemptsLeft: stored.attemptsLeft,
  };
  if (stored.status === "requires_action" && stored.actionUrl) {
    intent.actionUrl = stored.actionUrl;
  }
  // Non-production only: lets the demo flow be completed without a real SMS.
  if (!env.isProduction) {
    const devCode = takeDevCode(stored.id);
    if (devCode) intent.devCode = devCode;
  }
  return intent;
}

/** Card payload encrypted in the browser with the API's RSA public key. */
export interface EncryptedCardInput {
  keyId: string;
  encrypted: string;
}

/** Token produced by a PCI widget (Checkout.js / Stripe Elements / wallets). */
export interface TokenizedCardInput {
  provider: "yookassa" | "stripe";
  token: string;
  wallet?: "apple_pay" | "google_pay";
  brand?: string;
  last4?: string;
}

export type CardIntentInput = EncryptedCardInput | TokenizedCardInput;

export function isTokenizedCard(card: CardIntentInput): card is TokenizedCardInput {
  return "token" in card;
}

export interface CreateIntentInput {
  bookingId: string;
  method: PaymentMethod;
  phone: string;
  card?: CardIntentInput;
  paypal?: { email: string };
}

/** Decrypts the card payload the browser encrypted with our public key. */
function decryptCard(input: EncryptedCardInput) {
  const keyPair = getPaymentKeyPair();
  if (input.keyId !== keyPair.keyId) {
    throw ApiError.validation("The encryption key rotated — please submit the form again", [
      { field: "card", message: "Stale encryption key" },
    ]);
  }
  let plaintext: string;
  try {
    plaintext = keyPair.decrypt(input.encrypted);
  } catch {
    throw ApiError.validation("We could not read the card details", [
      { field: "card", message: "Card data could not be decrypted" },
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw ApiError.validation("We could not read the card details", [
      { field: "card", message: "Malformed card payload" },
    ]);
  }

  const result = decryptedCardSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: `card.${issue.path.join(".")}`,
      message: issue.message,
    }));
    throw ApiError.validation("Check your card details", details);
  }
  return result.data;
}

async function requireOwnedBooking(bookingId: string, userId: string): Promise<StoredBooking> {
  const booking = await findStoredBooking(bookingId);
  if (!booking || booking.userId !== userId) throw ApiError.notFound("Booking not found");
  if (booking.status === "cancelled" || booking.status === "expired") {
    throw ApiError.conflict("This booking is no longer payable");
  }
  if (booking.status === "confirmed") {
    throw ApiError.conflict("This booking has already been paid");
  }
  return booking;
}

export interface CreateIntentResult {
  payment: PaymentIntent;
  /** True when the SMS gateway delivered (or simulated) the message. */
  smsDelivered: boolean;
}

export async function createIntent(
  userId: string,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<CreateIntentResult> {
  const input = createPaymentIntentSchema.parse(rawInput);
  const booking = await requireOwnedBooking(input.bookingId, userId);
  const repos = getRepositories();

  let brand: CardBrand | null = null;
  let last4: string | null = null;
  let validatedCard: { number: string; expiry: string; cvc: string; name: string } | null = null;

  // The PSP is resolved up-front (and stored on the intent) so the charge at
  // verify time uses the same provider even if the config changes mid-flight.
  let provider: PaymentProvider;
  try {
    provider = providerForMethod(input.method);
  } catch (error) {
    throw ApiError.paymentFailed("Card payments are temporarily unavailable. Please try again later.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (input.method === "card" && input.card && isTokenizedCard(input.card)) {
    // Widget path: the PSP already validated the card, we only see a token.
    brand = (input.card.brand as CardBrand | undefined) ?? null;
    last4 = input.card.last4 ?? null;
  } else if (input.method === "card") {
    const card = decryptCard(input.card as EncryptedCardInput);
    const digits = card.number.replace(/\D/g, "");
    if (!luhnValid(digits)) {
      throw ApiError.validation("That card number is not valid", [
        { field: "card.number", message: "Enter a valid card number" },
      ]);
    }
    if (!cardExpiryValid(card.expiry, now)) {
      throw ApiError.validation("That card has expired", [
        { field: "card.expiry", message: "This card has expired" },
      ]);
    }
    if (DECLINED_CARDS.has(digits)) {
      recordPaymentOutcome(provider.name, "failed");
      throw ApiError.paymentFailed("Your card was declined by the issuer");
    }
    brand = detectCardBrand(digits);
    last4 = cardLast4(digits);
    validatedCard = { number: digits, expiry: card.expiry, cvc: card.cvc, name: card.name };
  } else if (input.paypal?.email.startsWith(PAYPAL_DECLINE_MARKER)) {
    recordPaymentOutcome(provider.name, "failed");
    throw ApiError.paymentFailed("PayPal declined this payment. Please try another method.");
  }

  // Only one live intent per booking — retrying must not double-charge.
  const existing = await repos.payments.findLiveByBooking(booking.id);
  if (existing) {
    if (new Date(existing.expiresAt).getTime() > now.getTime()) {
      return { payment: toIntent(existing), smsDelivered: true };
    }
    await repos.payments.update(existing.id, {
      status: "failed",
      failureReason: "expired",
      updatedAt: now.toISOString(),
    });
    dropCard(existing.id);
    dropDevCode(existing.id);
  }

  const phone = normalizePhone(input.phone);
  await assertSmsQuota(phone);

  const code = randomOtp(SMS_CODE_LENGTH);
  const expiresAt = new Date(now.getTime() + SMS_CODE_TTL_SECONDS * 1000);

  const payment: StoredPayment = {
    id: newId("pay"),
    bookingId: booking.id,
    method: input.method,
    status: "requires_code",
    amountCents: booking.quote.totalCents,
    currency: booking.currency,
    provider: provider.name,
    providerRef: null,
    actionUrl: null,
    cardBrand: brand,
    cardLast4: last4,
    phone,
    attemptsLeft: SMS_MAX_ATTEMPTS,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  // Hashing and delivery run in parallel; the OTP row is issued only after
  // the payment row persists, so a lost race leaves no orphan codes.
  const [sms, codeHash] = await Promise.all([
    dispatchSmsCode(phone, code),
    argonHash(code, { type: argon2id }),
  ]);
  if (!sms.delivered) {
    throw ApiError.paymentFailed("We could not send the confirmation code. Please try again.");
  }

  // Persisted only after a successful (or simulated) delivery. A concurrent
  // create may win the race — then its live intent is returned instead.
  const created = await repos.payments.create(payment);
  if (created.status === "live_exists") {
    const live = await repos.payments.findLiveByBooking(booking.id);
    if (live && new Date(live.expiresAt).getTime() > now.getTime()) {
      return { payment: toIntent(live), smsDelivered: true };
    }
    if (live) {
      await repos.payments.update(live.id, {
        status: "failed",
        failureReason: "expired",
        updatedAt: now.toISOString(),
      });
    }
    const retry = await repos.payments.create(payment);
    if (retry.status === "live_exists") {
      const relive = await repos.payments.findLiveByBooking(booking.id);
      if (!relive) throw ApiError.paymentFailed("Please try starting the payment again.");
      return { payment: toIntent(relive), smsDelivered: true };
    }
  }

  paymentsInFlight.inc(1);

  const otp: StoredOtpCode = {
    id: newId("otp"),
    userId,
    phone,
    purpose: "payment",
    key: payment.id,
    codeHash,
    expiresAt: expiresAt.toISOString(),
    attemptsLeft: SMS_MAX_ATTEMPTS,
    consumedAt: null,
    createdAt: now.toISOString(),
  };
  await repos.otpCodes.issue(otp);

  rememberDevCode(payment.id, code, expiresAt.getTime());
  if (validatedCard) {
    const [month, year] = validatedCard.expiry.split("/").map((part) => part.trim());
    rememberCard(
      payment.id,
      {
        number: validatedCard.number,
        expiryMonth: month!.padStart(2, "0"),
        expiryYear: `20${year}`,
        cvc: validatedCard.cvc,
        holder: validatedCard.name,
      },
      expiresAt.getTime(),
    );
  }

  return { payment: toIntent(payment), smsDelivered: sms.delivered };
}

async function assertIntentUsable(
  stored: StoredPayment | undefined,
  userId: string,
  now: Date,
): Promise<StoredPayment> {
  if (!stored) throw ApiError.notFound("Payment session not found");
  const booking = await findStoredBooking(stored.bookingId);
  if (!booking || booking.userId !== userId) throw ApiError.notFound("Payment session not found");
  if (stored.status !== "requires_code") {
    const state =
      stored.status === "requires_action"
        ? "already waiting for confirmation on the provider side"
        : `already ${stored.status}`;
    throw ApiError.paymentFailed(`This payment is ${state}.`, { payment: toIntent(stored) });
  }
  if (new Date(stored.expiresAt).getTime() <= now.getTime()) {
    await getRepositories().payments.update(stored.id, {
      status: "failed",
      failureReason: "expired",
      updatedAt: now.toISOString(),
    });
    dropCard(stored.id);
    dropDevCode(stored.id);
    throw ApiError.paymentFailed("The code expired. Please request a new one.");
  }
  return stored;
}

export interface VerifyResult {
  payment: PaymentIntent;
  booking: Booking;
}

/**
 * Step 2: the SMS code is checked first (2FA), and only then is the charge
 * executed against the PSP. The SMS code is NOT consumed by a transient
 * gateway failure — retrying with the same code re-attempts the charge with
 * the same idempotency key, so the PSP can never bill twice.
 */
export async function verifyCode(
  paymentId: string,
  rawInput: unknown,
  userId: string,
  now: Date = new Date(),
): Promise<VerifyResult> {
  const { code } = verifyPaymentSchema.parse(rawInput);
  const repos = getRepositories();
  const stored = await assertIntentUsable(await repos.payments.findById(paymentId), userId, now);

  const otp = await repos.otpCodes.findLive("payment", stored.id, now.toISOString());
  if (!otp) {
    // Consumed by a concurrent verify, or never issued: the intent itself is
    // untouched (a racing verify may still settle it) — the client refetches.
    throw ApiError.paymentFailed("This code is no longer valid. Please request a new one.");
  }
  if (otp.attemptsLeft <= 0) {
    await failIntent(repos, stored, "too_many_attempts", now);
    await audit("payment.failed", {
      userId,
      entityId: stored.id,
      meta: { bookingId: stored.bookingId, reason: "too_many_attempts" },
    });
    throw ApiError.paymentFailed("Too many incorrect codes. Please request a new one.");
  }

  const matches = await argonVerify(otp.codeHash, code).catch(() => false);
  if (!matches) {
    const result = await repos.otpCodes.decrement(otp.id, now.toISOString());
    const attemptsLeft = result === "gone" ? 0 : result.attemptsLeft;
    const terminal = attemptsLeft <= 0;
    await repos.payments.update(stored.id, {
      attemptsLeft,
      updatedAt: now.toISOString(),
      ...(terminal ? { status: "failed" as const, failureReason: "too_many_attempts" } : {}),
    });
    if (terminal) {
      dropCard(stored.id);
      dropDevCode(stored.id);
      await audit("payment.failed", {
        userId,
        entityId: stored.id,
        meta: { bookingId: stored.bookingId, reason: "too_many_attempts" },
      });
    }
    const current = (await repos.payments.findById(stored.id)) ?? { ...stored, attemptsLeft };
    throw ApiError.paymentFailed(
      attemptsLeft > 0
        ? `Incorrect code. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left.`
        : "Too many incorrect codes. Please request a new one.",
      { payment: toIntent(current) },
    );
  }

  // The code is correct — consume it before touching money, so a concurrent
  // verify with the same code cannot charge twice.
  const consumed = await repos.otpCodes.consume(otp.id, now.toISOString());
  if (!consumed) {
    throw ApiError.paymentFailed("This code is no longer valid. Please request a new one.");
  }

  // The same provider that was resolved at intent time is used, so a config
  // change mid-flight cannot split one payment across two PSPs.
  const provider = providerByName(stored.provider ?? "mock") ?? providerForMethod(stored.method);
  const booking = await findStoredBooking(stored.bookingId);
  if (!booking) throw ApiError.notFound("Booking not found");

  let methodData: ChargeMethodData;
  if (stored.method === "card") {
    // A widget token carries the card for us; otherwise the RSA-encrypted
    // payload remembered at intent time is decrypted here (in memory only).
    const token = takeToken(stored.id);
    if (token) {
      methodData = {
        kind: "card_token",
        token: token.token,
        provider: token.provider,
        wallet: token.wallet,
      };
    } else {
      const card = takeCard(stored.id);
      if (!card) {
        throw ApiError.paymentFailed("The payment session expired. Please start again.");
      }
      methodData = {
        kind: "card",
        number: card.number,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        cvc: card.cvc,
        holder: card.holder,
      };
    }
  } else {
    methodData = { kind: "paypal" };
  }

  try {
    const result = await provider.charge({
      idempotencyKey: stored.id,
      bookingId: stored.bookingId,
      amountCents: stored.amountCents,
      currency: stored.currency,
      method: stored.method,
      methodData,
      description: `CineTickets booking ${booking.code}`,
      returnUrl: `${env.APP_PUBLIC_URL.replace(/\/$/, "")}/payment-success/${stored.bookingId}`,
    });

    // The PSP has the details now — the memory copy is wiped either way.
    dropCard(stored.id);
    await repos.payments.update(stored.id, {
      providerRef: result.providerRef,
      actionUrl: result.actionUrl ?? null,
      updatedAt: now.toISOString(),
    });

    if (result.status === "succeeded") {
      await settleSucceeded(stored.id, now);
      await audit("payment.succeeded", {
        userId,
        entityId: stored.id,
        meta: { bookingId: stored.bookingId, amountCents: stored.amountCents },
      });
      const settled = await repos.payments.findById(stored.id);
      const paid = await findStoredBooking(stored.bookingId);
      if (!settled || !paid) throw ApiError.notFound("Payment session not found");
      return { payment: toIntent(settled), booking: toBooking(paid) };
    }

    // requires_action (3DS / PayPal approval) or pending: the booking stays
    // `pending` and is confirmed by the provider webhook. The client shows
    // the action URL; polling the booking is enough to observe completion.
    await repos.payments.update(stored.id, { status: "requires_action", updatedAt: now.toISOString() });
    const pending = await repos.payments.findById(stored.id);
    if (!pending) throw ApiError.notFound("Payment session not found");
    return { payment: toIntent(pending), booking: toBooking(booking) };
  } catch (error) {
    if (error instanceof ProviderChargeError) {
      if (error.kind === "declined") {
        await failIntent(repos, stored, "declined", now);
        await audit("payment.failed", {
          userId,
          entityId: stored.id,
          meta: { bookingId: stored.bookingId, reason: "declined" },
        });
        const failed = await repos.payments.findById(stored.id);
        throw ApiError.paymentFailed(error.message, { payment: failed ? toIntent(failed) : undefined });
      }
      // Transient gateway failure: the intent (and the memorised card) stay
      // alive, and the consumed code is re-issued as-is, so retrying with the
      // same code re-attempts the same idempotent charge.
      await repos.otpCodes.issue({
        id: newId("otp"),
        userId,
        phone: stored.phone,
        purpose: "payment",
        key: stored.id,
        codeHash: otp.codeHash,
        expiresAt: otp.expiresAt,
        attemptsLeft: otp.attemptsLeft,
        consumedAt: null,
        createdAt: now.toISOString(),
      });
      if (methodData.kind === "card_token") {
        rememberToken(stored.id, {
          provider: methodData.provider,
          token: methodData.token,
          wallet: methodData.wallet,
          expiresAt: new Date(stored.expiresAt).getTime(),
        });
      } else if (stored.method === "card") {
        const card = methodData as Extract<ChargeMethodData, { kind: "card" }>;
        rememberCard(
          stored.id,
          {
            number: card.number,
            expiryMonth: card.expiryMonth,
            expiryYear: card.expiryYear,
            cvc: card.cvc,
            holder: card.holder,
          },
          new Date(stored.expiresAt).getTime(),
        );
      }
      throw ApiError.paymentFailed(error.message || "The payment provider is unavailable. Please try again.");
    }
    throw error;
  }
}

/** Fails the intent and wipes its memory-only secrets (card, demo code). */
async function failIntent(
  repos: ReturnType<typeof getRepositories>,
  stored: StoredPayment,
  reason: string,
  now: Date,
): Promise<void> {
  await repos.payments.update(stored.id, {
    status: "failed",
    failureReason: reason,
    updatedAt: now.toISOString(),
  });
  recordPaymentOutcome(stored.provider ?? "mock", "failed");
  paymentsInFlight.dec(1);
  dropCard(stored.id);
  dropToken(stored.id);
  dropDevCode(stored.id);
}

/** Marks the intent settled and confirms the booking (sync PSP success path). */
async function settleSucceeded(paymentId: string, now: Date): Promise<void> {
  const repos = getRepositories();
  const stored = await repos.payments.findById(paymentId);
  if (!stored) throw ApiError.notFound("Payment session not found");
  await confirmBooking(stored.bookingId, now);
  // The ticket only ever shows the masked number — the full phone number is
  // dropped together with the code as soon as the payment settles.
  await recordPayment(stored.bookingId, {
    method: stored.method,
    brand: stored.cardBrand,
    last4: stored.cardLast4,
    phoneMasked: maskPhoneForDisplay(stored.phone),
    provider: stored.provider ?? "mock",
  });
  await repos.payments.update(stored.id, { status: "succeeded", updatedAt: now.toISOString() });
  recordPaymentOutcome(stored.provider ?? "mock", "succeeded");
  paymentsInFlight.dec(1);
  // The code is useless once the payment is settled.
  dropDevCode(stored.id);
}

export async function resendCode(
  paymentId: string,
  userId: string,
  now: Date = new Date(),
): Promise<{ payment: PaymentIntent; delivered: boolean }> {
  const repos = getRepositories();
  const stored = await assertIntentUsable(await repos.payments.findById(paymentId), userId, now);
  await assertSmsQuota(stored.phone);

  const code = randomOtp(SMS_CODE_LENGTH);
  const expiresAt = new Date(now.getTime() + SMS_CODE_TTL_SECONDS * 1000);
  const [sms, codeHash] = await Promise.all([
    dispatchSmsCode(stored.phone, code),
    argonHash(code, { type: argon2id }),
  ]);
  if (!sms.delivered) {
    throw ApiError.paymentFailed("We could not send the code. Please try again shortly.");
  }

  await repos.payments.update(stored.id, {
    expiresAt: expiresAt.toISOString(),
    attemptsLeft: SMS_MAX_ATTEMPTS,
    updatedAt: now.toISOString(),
  });
  await repos.otpCodes.issue({
    id: newId("otp"),
    userId,
    phone: stored.phone,
    purpose: "payment",
    key: stored.id,
    codeHash,
    expiresAt: expiresAt.toISOString(),
    attemptsLeft: SMS_MAX_ATTEMPTS,
    consumedAt: null,
    createdAt: now.toISOString(),
  });
  rememberDevCode(stored.id, code, expiresAt.getTime());

  const updated = await repos.payments.findById(stored.id);
  if (!updated) throw ApiError.notFound("Payment session not found");
  return { payment: toIntent(updated), delivered: true };
}

export async function getIntent(paymentId: string, userId: string): Promise<PaymentIntent> {
  const stored = await getRepositories().payments.findById(paymentId);
  if (!stored) throw ApiError.notFound("Payment session not found");
  const booking = await findStoredBooking(stored.bookingId);
  if (!booking || booking.userId !== userId) throw ApiError.notFound("Payment session not found");
  return toIntent(stored);
}
