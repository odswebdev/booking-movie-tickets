import { hash as argonHash, argon2id, verify as argonVerify } from "argon2";
import jwt from "jsonwebtoken";
import {
  claimGuestSchema,
  guestCheckoutSchema,
  magicLinkRequestSchema,
  magicLinkVerifySchema,
} from "../../../shared/schemas.js";
import type { AuthSession, Booking, User } from "../../../shared/types.js";
import { getRepositories } from "../db/provider.js";
import type { StoredOtpCode, StoredUser } from "../db/schema.js";
import { env } from "../config/env.js";
import { ApiError } from "../utils/errors.js";
import { hashPassword, randomToken } from "../utils/crypto.js";
import { newId, randomOtp } from "../utils/ids.js";
import { logger } from "../utils/logger.js";
import { SMS_CODE_LENGTH, SMS_CODE_TTL_SECONDS, SMS_MAX_ATTEMPTS } from "../../../shared/pricing.js";
import { audit } from "./auditService.js";
import { createBooking, type CreateBookingArgs } from "./bookingService.js";
import { buildMagicLinkEmail } from "./emailService.js";
import { enqueueEmailMessage } from "../queues/queueService.js";
import { dispatchSmsCode } from "../queues/queueService.js";
import { maskPhone } from "./smsService.js";
import { ensureReferralCode } from "./loyaltyService.js";

/**
 * Checkout & sign-in flows that are not password-based (ТЗ §5):
 *
 * - guest checkout — buy without an account, keep a scoped access token;
 * - magic link — passwordless e-mail sign-in (the missing email template);
 * - phone verification — OTP (`phone_verify`) that marks a number as verified.
 */

/* --------------------------------------------------------------------------
 * Guest checkout
 * ------------------------------------------------------------------------ */

type GuestClaims = { sub: string; typ: "access"; guest: true; bkg: string };

/**
 * Access token for a guest session.
 *
 * It is a regular `access` token (so every authenticated endpoint — payment,
 * ticket, receipt, refund — works unchanged) with two extra claims: the
 * account is a guest, and it was minted for one booking. Guests who claim the
 * account keep the same user row, so their tickets survive the upgrade.
 */
export function signGuestToken(userId: string, bookingId: string): { token: string; expiresAt: number } {
  const ttlSeconds = env.GUEST_TOKEN_TTL_HOURS * 3600;
  const token = jwt.sign(
    { sub: userId, typ: "access", guest: true, bkg: bookingId } satisfies GuestClaims,
    env.jwtSecret,
    {
      expiresIn: ttlSeconds,
      issuer: "movie-tickets-api",
      audience: "movie-tickets-web",
    },
  );
  return { token, expiresAt: Date.now() + ttlSeconds * 1000 };
}

export function verifyGuestToken(token: string): GuestClaims | null {
  try {
    const claims = jwt.verify(token, env.jwtSecret, {
      issuer: "movie-tickets-api",
      audience: "movie-tickets-web",
    }) as GuestClaims;
    return claims.guest === true ? claims : null;
  } catch {
    return null;
  }
}

function toPublicUser(user: StoredUser): User {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    phoneVerifiedAt: user.phoneVerifiedAt ?? null,
    createdAt: user.createdAt,
  };
}

/** Reuses the guest account for a repeat buyer (same e-mail), or creates one. */
async function findOrCreateGuest(input: {
  name: string;
  email: string;
  phone?: string;
}): Promise<StoredUser> {
  const repos = getRepositories();
  const existing = await repos.users.findByEmail(input.email);
  if (existing) {
    if (!existing.isGuest) {
      throw ApiError.conflict("An account with this email already exists — please sign in to continue", {
        field: "email",
      });
    }
    return existing;
  }

  const user: StoredUser = {
    id: newId("usr"),
    name: input.name,
    email: input.email,
    // Guests cannot sign in until they claim the account: the hash is a
    // random, unknowable secret (passwordless by construction).
    passwordHash: await hashPassword(randomToken(32)),
    phone: input.phone ?? null,
    isGuest: true,
    createdAt: new Date().toISOString(),
  };
  await repos.users.create(user);
  await ensureReferralCode(user);
  await audit("auth.guest_created", { userId: user.id, entityId: user.id });
  return user;
}

export interface GuestCheckoutResult {
  booking: Booking;
  guest: { token: string; expiresAt: number };
  user: User;
}

/**
 * Guest checkout: creates the seat hold/booking for a lightweight account and
 * returns a token scoped to that booking (payment, ticket view, receipt).
 */
export async function createGuestBooking(
  rawInput: unknown,
  bookingInput: Omit<CreateBookingArgs, "userId">,
): Promise<GuestCheckoutResult> {
  const details = guestCheckoutSchema.parse(rawInput);
  const user = await findOrCreateGuest(details);

  if (details.phone) {
    await getRepositories().users.setPhoneVerified(user.id, details.phone, new Date().toISOString());
  }

  const booking = await createBooking({ ...bookingInput, userId: user.id });
  const guest = signGuestToken(user.id, booking.id);
  await audit("booking.guest_created", {
    userId: user.id,
    entityId: booking.id,
    meta: { showtimeId: booking.showtimeId },
  });

  return { booking, guest, user: toPublicUser(user) };
}

/**
 * Claiming a guest account: setting a password turns it into a normal one —
 * the tickets bought as a guest stay attached to the same user.
 */
export async function claimGuestAccount(rawInput: unknown): Promise<AuthSession> {
  const input = claimGuestSchema.parse(rawInput);
  const claims = verifyGuestToken(input.guestToken);
  if (!claims) throw ApiError.unauthorized("This guest link has expired. Please sign in or contact support.");

  const repos = getRepositories();
  const user = await repos.users.findById(claims.sub);
  if (!user) throw ApiError.notFound("Guest account not found");
  if (!user.isGuest) throw ApiError.conflict("This account already has a password — just sign in");

  const claimed: StoredUser = {
    ...user,
    passwordHash: await hashPassword(input.password),
    isGuest: false,
  };
  await repos.users.updateProfile?.(claimed);
  await audit("auth.guest_claimed", { userId: user.id, entityId: user.id });

  const { issueSessionFor } = await import("./authService.js");
  return issueSessionFor(claimed);
}

/* --------------------------------------------------------------------------
 * Magic link (passwordless sign-in)
 * ------------------------------------------------------------------------ */

const MAGIC_LINK_PURPOSE = "login";

/**
 * Always answers with the same shape: whether the address has an account is
 * not something an anonymous caller gets to enumerate.
 */
export async function requestMagicLink(
  rawInput: unknown,
): Promise<{ delivered: boolean; devToken?: string }> {
  const { email } = magicLinkRequestSchema.parse(rawInput);
  const repos = getRepositories();
  const user = await repos.users.findByEmail(email);
  if (!user) return { delivered: false };

  // The link is a signed JWT (e-mail + single-use secret). The secret itself
  // is stored argon2-hashed in `OtpCode`, so a link can be used exactly once.
  const secret = randomToken(32);
  const token = jwt.sign({ typ: "magic", email, jti: secret }, env.jwtSecret, {
    expiresIn: env.MAGIC_LINK_TTL_MINUTES * 60,
    issuer: "movie-tickets-api",
    audience: "movie-tickets-web",
  });
  const codeHash = await argonHash(secret, { type: argon2id });
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.MAGIC_LINK_TTL_MINUTES * 60_000);

  const otp: StoredOtpCode = {
    id: newId("otp"),
    userId: user.id,
    phone: user.phone ?? `email:${email}`,
    purpose: MAGIC_LINK_PURPOSE,
    key: email,
    codeHash,
    expiresAt: expiresAt.toISOString(),
    attemptsLeft: SMS_MAX_ATTEMPTS,
    consumedAt: null,
    createdAt: now.toISOString(),
  };
  await repos.otpCodes.issue(otp);

  const url = `${env.APP_PUBLIC_URL.replace(/\/$/, "")}/login?magic=${encodeURIComponent(token)}`;
  const message = buildMagicLinkEmail({ to: email, url, minutes: env.MAGIC_LINK_TTL_MINUTES });
  const result = await enqueueEmailMessage(message);
  // Demo/e2e convenience: with the mock provider the token is echoed back so
  // the flow is testable end-to-end (same idea as the dev SMS code).
  const devToken = env.isProduction ? undefined : token;
  return { delivered: result.delivered, devToken };
}

interface MagicClaims {
  typ: "magic";
  email: string;
  jti: string;
}

/** Consumes the magic-link token and answers with a normal session. */
export async function verifyMagicLink(rawInput: unknown): Promise<AuthSession> {
  const { token } = magicLinkVerifySchema.parse(rawInput);
  const repos = getRepositories();

  let claims: MagicClaims;
  try {
    const decoded = jwt.verify(token, env.jwtSecret, {
      issuer: "movie-tickets-api",
      audience: "movie-tickets-web",
    }) as MagicClaims;
    if (decoded.typ !== "magic") throw new Error("wrong token type");
    claims = decoded;
  } catch {
    throw ApiError.unauthorized("This sign-in link is invalid or has expired");
  }

  const now = new Date();
  const otp = await repos.otpCodes.findLive(MAGIC_LINK_PURPOSE, claims.email, now.toISOString());
  if (!otp) throw ApiError.unauthorized("This sign-in link has expired — request a new one");

  const matches = await argonVerify(otp.codeHash, claims.jti).catch(() => false);
  if (!matches) {
    await repos.otpCodes.decrement(otp.id, now.toISOString());
    throw ApiError.unauthorized("This sign-in link is invalid — request a new one");
  }
  const consumed = await repos.otpCodes.consume(otp.id, now.toISOString());
  if (!consumed) throw ApiError.unauthorized("This sign-in link was already used");

  const user = await repos.users.findByEmail(claims.email);
  if (!user) throw ApiError.unauthorized("Account not found");
  await audit("auth.magic_link", { userId: user.id, entityId: user.id });
  const { issueSessionFor } = await import("./authService.js");
  return issueSessionFor(user);
}

/* --------------------------------------------------------------------------
 * Phone verification (OTP purpose `phone_verify`)
 * ------------------------------------------------------------------------ */

export async function requestPhoneVerification(
  userId: string,
  rawPhone: string,
): Promise<{ delivered: boolean; phoneMasked: string; devCode?: string }> {
  const { normalizePhone } = await import("./smsService.js");
  const { phoneSchema } = await import("../../../shared/schemas.js");
  const phone = phoneSchema.parse(rawPhone);
  const repos = getRepositories();
  const user = await repos.users.findById(userId);
  if (!user) throw ApiError.notFound("Account not found");

  const existing = await repos.users.findByPhone?.(phone);
  if (existing && existing.id !== userId) {
    throw ApiError.conflict("That number is already linked to another account", { field: "phone" });
  }

  const code = randomOtp(SMS_CODE_LENGTH);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SMS_CODE_TTL_SECONDS * 1000);
  const codeHash = await argonHash(code, { type: argon2id });

  await repos.otpCodes.issue({
    id: newId("otp"),
    userId,
    phone,
    purpose: "phone_verify",
    key: userId,
    codeHash,
    expiresAt: expiresAt.toISOString(),
    attemptsLeft: SMS_MAX_ATTEMPTS,
    consumedAt: null,
    createdAt: now.toISOString(),
  });

  const result = await dispatchSmsCode(phone, code);
  if (!result.delivered) throw ApiError.paymentFailed("We could not send the code. Please try again.");
  logger.info({ userId, phone: maskPhone(phone) }, "phone verification code sent");
  // Demo/e2e convenience: with the mock gateway the code is echoed back
  // (same contract as the payment `devCode`); never in production.
  return {
    delivered: true,
    phoneMasked: maskPhone(normalizePhone(phone)),
    devCode: env.isProduction ? undefined : code,
  };
}

export async function confirmPhoneVerification(
  userId: string,
  rawCode: string,
  rawPhone?: string,
): Promise<User> {
  const repos = getRepositories();
  const now = new Date();
  const otp = await repos.otpCodes.findLive("phone_verify", userId, now.toISOString());
  if (!otp) throw ApiError.paymentFailed("This code is no longer valid. Please request a new one.");
  if (otp.attemptsLeft <= 0)
    throw ApiError.paymentFailed("Too many incorrect codes. Please request a new one.");

  const matches = await argonVerify(otp.codeHash, rawCode).catch(() => false);
  if (!matches) {
    const result = await repos.otpCodes.decrement(otp.id, now.toISOString());
    const left = result === "gone" ? 0 : result.attemptsLeft;
    throw ApiError.paymentFailed(`Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.`);
  }

  const consumed = await repos.otpCodes.consume(otp.id, now.toISOString());
  if (!consumed) throw ApiError.paymentFailed("This code is no longer valid. Please request a new one.");

  const phone = rawPhone ?? otp.phone;
  await repos.users.setPhoneVerified(userId, phone, now.toISOString());
  const user = await repos.users.findById(userId);
  if (!user) throw ApiError.notFound("Account not found");
  return toPublicUser(user);
}

export { toPublicUser };
