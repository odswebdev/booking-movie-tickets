import jwt, { type JwtPayload } from "jsonwebtoken";
import { loginSchema, registerSchema, refreshSchema } from "../../../shared/schemas.js";
import type {
  AuditEvent,
  AuthSession,
  Booking,
  CardBrand,
  Currency,
  PaymentMethod,
  PaymentStatus,
  User,
} from "../../../shared/types.js";
import type { StoredRefreshToken, StoredUser } from "../db/schema.js";
import { getRepositories } from "../db/provider.js";
import { isDuplicateEmail } from "../db/json/repositories.js";
import { env } from "../config/env.js";
import { ApiError } from "../utils/errors.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "../utils/crypto.js";
import { newId } from "../utils/ids.js";
import { logger } from "../utils/logger.js";
import { parseTtlSeconds } from "../utils/time.js";
import { audit } from "./auditService.js";
import { toBooking } from "./bookingService.js";
import { maskPhone } from "./smsService.js";
import {
  applyReferral,
  deleteLoyaltyForUser,
  ensureReferralCode,
  exportLoyaltyForUser,
} from "./loyaltyService.js";

type JwtType = "access" | "refresh";

export interface TokenClaims extends JwtPayload {
  sub: string;
  typ: JwtType;
  jti?: string;
}

function signToken(userId: string, type: JwtType, ttl: string): { token: string; expiresAt: number } {
  const payload: TokenClaims = { sub: userId, typ: type };
  // Accepts any documented value: 30s, 15m, 1h, 7d (see env validation).
  const expiresInSeconds = parseTtlSeconds(ttl);
  const token = jwt.sign(payload, env.jwtSecret, {
    expiresIn: expiresInSeconds,
    issuer: "movie-tickets-api",
    audience: "movie-tickets-web",
  });
  return { token, expiresAt: Date.now() + expiresInSeconds * 1000 };
}

/** Issues a full session (access + rotating refresh) for a user row. */
export async function issueSessionFor(user: StoredUser, userAgent?: string): Promise<AuthSession> {
  return issueSession(user, userAgent);
}

export function verifyToken(token: string, type: JwtType): TokenClaims {
  try {
    const decoded = jwt.verify(token, env.jwtSecret, {
      issuer: "movie-tickets-api",
      audience: "movie-tickets-web",
    }) as TokenClaims;
    if (decoded.typ !== type) throw new Error(`expected a "${type}" token, got "${decoded.typ}"`);
    return decoded;
  } catch (error) {
    // Diagnostics only: exp/iat/typ are metadata, never the signature or the user's data.
    const claims = jwt.decode(token) as JwtPayload | null;
    logger.warn(
      {
        reason: (error as Error).message,
        expected: type,
        typ: claims?.typ ?? null,
        iat: claims?.iat ?? null,
        exp: claims?.exp ?? null,
        serverNow: Math.floor(Date.now() / 1000),
        skewSeconds: claims?.exp ? claims.exp - Math.floor(Date.now() / 1000) : null,
      },
      "access token rejected",
    );
    throw ApiError.unauthorized("Your session has expired. Please sign in again.");
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

export async function issueSession(user: StoredUser, userAgent?: string): Promise<AuthSession> {
  const access = signToken(user.id, "access", env.JWT_ACCESS_TTL);
  const refreshToken = randomToken(32);
  const now = new Date();

  await getRepositories().sessions.create({
    id: newId("rt"),
    userId: user.id,
    tokenHash: sha256(refreshToken),
    expiresAt: new Date(now.getTime() + env.JWT_REFRESH_TTL_DAYS * 86_400_000).toISOString(),
    revokedAt: null,
    replacedBy: null,
    createdAt: now.toISOString(),
    userAgent,
  });

  return {
    user: toPublicUser(user),
    accessToken: access.token,
    refreshToken,
    expiresAt: access.expiresAt,
  };
}

export async function register(input: unknown, userAgent?: string): Promise<AuthSession> {
  const data = registerSchema.parse(input); // throws ZodError → mapped by the route
  const repos = getRepositories();
  const email = data.email;
  if (await repos.users.findByEmail(email)) {
    throw ApiError.conflict("An account with this email already exists", { field: "email" });
  }

  const user: StoredUser = {
    id: newId("usr"),
    name: data.name,
    email,
    passwordHash: await hashPassword(data.password),
    isGuest: false,
    createdAt: new Date().toISOString(),
  };
  try {
    await repos.users.create(user);
  } catch (error) {
    // Lost a same-email registration race — same answer as the check above.
    if (isDuplicateEmail(error)) {
      throw ApiError.conflict("An account with this email already exists", { field: "email" });
    }
    throw error;
  }

  // Loyalty: the account gets a public invite code, and a signup that used
  // somebody's code credits both sides (never fatal for the signup itself).
  const ownCode = await ensureReferralCode(user);
  if (data.referralCode) await applyReferral({ ...user, referralCode: ownCode }, data.referralCode);

  await audit("auth.register", { userId: user.id, entityId: user.id });
  return issueSession(user, userAgent);
}

export async function login(input: unknown, userAgent?: string): Promise<AuthSession> {
  const data = loginSchema.parse(input);
  const user = await getRepositories().users.findByEmail(data.email);
  const ok = user ? await verifyPassword(data.password, user.passwordHash) : false;
  if (!user || !ok) {
    // Deliberately identical message for unknown email and wrong password.
    throw ApiError.unauthorized("Email or password is incorrect");
  }
  await audit("auth.login", { userId: user.id, entityId: user.id });
  return issueSession(user, userAgent);
}

/** Rotate-and-revoke: a refresh token can only be exchanged once. */
export async function refreshSession(input: unknown, userAgent?: string): Promise<AuthSession> {
  const { refreshToken } = refreshSchema.parse(input);
  const repos = getRepositories();
  const tokenHash = sha256(refreshToken);
  const stored = await repos.sessions.findByTokenHash(tokenHash);

  if (!stored) throw ApiError.unauthorized("Invalid refresh token");

  if (stored.revokedAt) {
    const revokedAtMs = new Date(stored.revokedAt).getTime();
    const withinGrace = Date.now() - revokedAtMs < env.REFRESH_REUSE_GRACE_MS;

    if (!withinGrace) {
      // A token that has been dead for a while being replayed looks like theft:
      // revoke the sessions that existed when it was rotated — but never the
      // newer ones, so signing in again always works.
      await repos.sessions.revokeOlderSessions(
        stored.userId,
        stored.revokedAt,
        stored.replacedBy,
        new Date().toISOString(),
      );
      logger.warn({ userId: stored.userId }, "refresh token reuse detected; older sessions revoked");
      throw ApiError.unauthorized("This session is no longer valid. Please sign in again.");
    }

    // Two tabs refreshing at once is a race, not an attack: rotate again
    // instead of locking the user out.
    logger.warn({ userId: stored.userId }, "refresh token replayed within the grace window");
  }
  if (new Date(stored.expiresAt).getTime() < Date.now()) {
    throw ApiError.unauthorized("Your session has expired. Please sign in again.");
  }

  const user = await repos.users.findById(stored.userId);
  if (!user) throw ApiError.unauthorized("Account no longer exists");

  const access = signToken(user.id, "access", env.JWT_ACCESS_TTL);
  const nextRefreshToken = randomToken(32);
  const now = new Date();
  const next: StoredRefreshToken = {
    id: newId("rt"),
    userId: user.id,
    tokenHash: sha256(nextRefreshToken),
    expiresAt: new Date(now.getTime() + env.JWT_REFRESH_TTL_DAYS * 86_400_000).toISOString(),
    revokedAt: null,
    replacedBy: null,
    createdAt: now.toISOString(),
    userAgent,
  };
  await repos.sessions.rotate(tokenHash, next, now.toISOString());

  return {
    user: toPublicUser(user),
    accessToken: access.token,
    refreshToken: nextRefreshToken,
    expiresAt: access.expiresAt,
  };
}

export async function logout(refreshToken?: string): Promise<void> {
  if (!refreshToken) return;
  await getRepositories().sessions.revokeByHash(sha256(refreshToken), new Date().toISOString());
}

export async function getUserById(id: string): Promise<User | undefined> {
  const stored = await getRepositories().users.findById(id);
  return stored ? toPublicUser(stored) : undefined;
}

/** Masked payment row for the GDPR export (no full phone, no secrets). */
export interface ExportedPayment {
  id: string;
  bookingId: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amountCents: number;
  currency: Currency;
  cardBrand: CardBrand | null;
  cardLast4: string | null;
  phoneMasked: string;
  createdAt: string;
}

export interface AccountExport {
  user: User;
  bookings: Booking[];
  payments: ExportedPayment[];
  audit: AuditEvent[];
  /** Loyalty points, referral reviews — part of the GDPR export too. */
  loyalty: Awaited<ReturnType<typeof exportLoyaltyForUser>>;
  exportedAt: string;
}

/** GDPR data-portability export: everything the service stores about the user. */
export async function exportAccount(userId: string): Promise<AccountExport> {
  const repos = getRepositories();
  const stored = await repos.users.findById(userId);
  if (!stored) throw ApiError.notFound("Account not found");
  const bookings = await repos.bookings.listByUser(userId);
  const payments = await repos.payments.listByBookingIds(bookings.map((booking) => booking.id));
  const trail = await repos.audit.listByUser(userId);
  const loyalty = await exportLoyaltyForUser(userId);
  await audit("account.exported", { userId });
  return {
    user: toPublicUser(stored),
    bookings: bookings.map(toBooking),
    payments: payments.map((payment) => ({
      id: payment.id,
      bookingId: payment.bookingId,
      method: payment.method,
      status: payment.status,
      amountCents: payment.amountCents,
      currency: payment.currency,
      cardBrand: payment.cardBrand,
      cardLast4: payment.cardLast4,
      phoneMasked: maskPhone(payment.phone),
      createdAt: payment.createdAt,
    })),
    audit: trail.map((entry) => ({
      id: entry.id,
      at: entry.at,
      action: entry.action,
      entityId: entry.entityId,
      meta: entry.meta,
    })),
    loyalty,
    exportedAt: new Date().toISOString(),
  };
}

/**
 * GDPR erasure: audit first (the trail keeps no PII, so it survives), then
 * payments → bookings (seats are freed: occupancy derives from bookings) →
 * sessions → the user itself. Postgres cascades are a backstop; JSON relies
 * on these explicit deletes.
 *
 * NOTE: the access token stays valid until the short-lived JWT expires (15m);
 * the refresh token is revoked immediately, so the session cannot renew.
 */
export async function deleteAccount(userId: string): Promise<void> {
  const repos = getRepositories();
  const stored = await repos.users.findById(userId);
  if (!stored) throw ApiError.notFound("Account not found");
  await audit("account.deleted", { userId, entityId: userId });
  const bookings = await repos.bookings.listByUser(userId);
  const payments = await repos.payments.deleteByBookingIds(bookings.map((booking) => booking.id));
  const removed = await repos.bookings.deleteByUser(userId);
  const sessions = await repos.sessions.deleteByUser(userId);
  // Bonus points, referrals and reviews go with the account (JSON mode has no
  // cascades; Postgres cascades are a backstop).
  await deleteLoyaltyForUser(userId);
  await repos.users.delete(userId);
  logger.info({ userId, bookings: removed, payments, sessions }, "account erased");
}
