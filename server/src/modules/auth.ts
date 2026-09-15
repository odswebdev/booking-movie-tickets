import { Router, type Request, type Response } from "express";
import {
  claimGuestSchema,
  guestBookingSchema,
  loginSchema,
  magicLinkRequestSchema,
  magicLinkVerifySchema,
  refreshSchema,
  registerSchema,
} from "../../../shared/schemas.js";
import { z } from "zod";
import { env } from "../config/env.js";
import * as authService from "../services/authService.js";
import {
  claimGuestAccount,
  confirmPhoneVerification,
  createGuestBooking,
  requestMagicLink,
  requestPhoneVerification,
  verifyMagicLink,
} from "../services/authFlows.js";
import { loyaltySummary } from "../services/loyaltyService.js";
import { getRepositories } from "../db/provider.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { authLimiter } from "../middleware/rateLimit.js";
import { ApiError } from "../utils/errors.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { SESSION_COOKIE } from "../config/env.js";
import { parseTtlSeconds } from "../utils/time.js";

/**
 * Mirrors the access token into an httpOnly cookie so the browser keeps sending
 * it even when the SPA cannot (lost storage, strict privacy settings, iframes).
 * SameSite=Lax keeps cross-site POSTs cookie-less, so this is CSRF-safe.
 *
 * When the web client runs on a different host than the API (dev servers on
 * separate ports, preview URLs, tunnels), Lax cookies are never sent back, so
 * the cookie switches to SameSite=None; Secure — but only over HTTPS, since
 * browsers reject `SameSite=None` without `Secure` and plain-http localhost
 * would otherwise lose the cookie entirely. The header-based auth
 * (`Authorization` / `X-Auth-Token`) always works regardless of cookies.
 */
function sendSession(req: Request, res: Response, session: { accessToken: string }): void {
  let sameSite: "lax" | "none" = "lax";
  let secure = env.isProduction;
  const origin = req.header("origin");
  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      const host = (req.get("host") ?? "").toLowerCase();
      if (host && originHost && originHost !== host) {
        sameSite = "none";
        secure = true;
      }
    } catch {
      // Malformed Origin — keep the safe Lax defaults.
    }
  }
  const forwardedProto = (req.header("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase();
  const isHttps = req.secure || req.protocol === "https" || forwardedProto === "https";
  if (!isHttps) {
    sameSite = "lax";
    secure = false;
  }
  res.cookie(SESSION_COOKIE, session.accessToken, {
    httpOnly: true,
    sameSite,
    secure,
    maxAge: parseTtlSeconds(env.JWT_ACCESS_TTL) * 1000,
    path: "/",
  });
}

export const authRouter: Router = Router();

authRouter.post(
  "/register",
  authLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const session = await authService.register(req.body, req.header("user-agent"));
    sendSession(req, res, session);
    res.status(201).json(session);
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const session = await authService.login(req.body, req.header("user-agent"));
    sendSession(req, res, session);
    res.json(session);
  }),
);

authRouter.post(
  "/refresh",
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const session = await authService.refreshSession(req.body, req.header("user-agent"));
    sendSession(req, res, session);
    res.json(session);
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    await authService.logout(token);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.status(204).end();
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await authService.getUserById(req.auth!.userId);
    if (!user) throw ApiError.notFound("Account not found");
    res.json({ user });
  }),
);

/**
 * GDPR data-portability export: user, bookings, masked payments, audit trail.
 */
authRouter.get(
  "/export",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await authService.exportAccount(req.auth!.userId));
  }),
);

/**
 * GDPR erasure: payments → bookings → sessions → user. The session cookie is
 * cleared and the refresh token revoked; the short-lived access token simply
 * expires within 15 minutes.
 */
authRouter.delete(
  "/account",
  requireAuth,
  asyncHandler(async (req, res) => {
    await authService.deleteAccount(req.auth!.userId);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.status(204).end();
  }),
);

/* --------------------------------------------------------------------------
 * Magic link (ТЗ §6: email — билеты, чеки, magic link)
 * ------------------------------------------------------------------------ */

/** Requests a single-use sign-in link. Always answers the same way. */
authRouter.post(
  "/magic-link",
  authLimiter,
  validate(magicLinkRequestSchema),
  asyncHandler(async (req, res) => {
    const result = await requestMagicLink(req.body);
    res.status(202).json({
      requested: true,
      ...(result.devToken ? { devToken: result.devToken } : {}),
    });
  }),
);

/** Consumes the link and starts a normal session. */
authRouter.post(
  "/magic-link/verify",
  authLimiter,
  validate(magicLinkVerifySchema),
  asyncHandler(async (req, res) => {
    const session = await verifyMagicLink(req.body);
    sendSession(req, res, session);
    res.json(session);
  }),
);

/* --------------------------------------------------------------------------
 * Guest checkout (ТЗ §5: гостевой checkout + SMS-верификация)
 * ------------------------------------------------------------------------ */

/**
 * Books seats for a guest: a lightweight account is created (or reused for a
 * returning buyer) and the response carries a guest token scoped to the
 * booking, so the same endpoints — payment, ticket, receipt — just work.
 */
authRouter.post(
  "/guest",
  authLimiter,
  validate(guestBookingSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof guestBookingSchema>;
    const result = await createGuestBooking(input, {
      showtimeId: input.showtimeId,
      seatIds: input.seatIds,
      holdToken: input.holdToken,
      promoCode: input.promoCode,
      bonusCents: input.bonusCents,
    });
    res.status(201).json(result);
  }),
);

/**
 * Turns a guest account into a full one: setting a password keeps the same
 * user row, so tickets bought as a guest stay attached.
 */
authRouter.post(
  "/guest/claim",
  authLimiter,
  validate(claimGuestSchema),
  asyncHandler(async (req, res) => {
    const session = await claimGuestAccount(req.body);
    sendSession(req, res, session);
    res.json(session);
  }),
);

/* --------------------------------------------------------------------------
 * Phone verification (OTP purpose `phone_verify`, ТЗ §2)
 * ------------------------------------------------------------------------ */

const phoneRequestSchema = z.object({ phone: z.string().trim().min(6).max(20) });
const phoneConfirmSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "The code is 6 digits"),
  phone: z.string().trim().min(6).max(20).optional(),
});

/** Sends (or re-sends) a verification code to the account's phone number. */
authRouter.post(
  "/phone/verify",
  authLimiter,
  requireAuth,
  validate(phoneRequestSchema),
  asyncHandler(async (req, res) => {
    const { phone } = req.body as z.infer<typeof phoneRequestSchema>;
    res.json(await requestPhoneVerification(req.auth!.userId, phone));
  }),
);

/** Confirms the code: the number is marked verified on the user row. */
authRouter.post(
  "/phone/confirm",
  authLimiter,
  requireAuth,
  validate(phoneConfirmSchema),
  asyncHandler(async (req, res) => {
    const { code, phone } = req.body as z.infer<typeof phoneConfirmSchema>;
    const user = await confirmPhoneVerification(req.auth!.userId, code, phone);
    res.json({ user });
  }),
);

/* --------------------------------------------------------------------------
 * Loyalty (ТЗ §2: BonusTransaction / Referral)
 * ------------------------------------------------------------------------ */

/** Bonus balance, transaction history and the personal referral code. */
authRouter.get(
  "/loyalty",
  requireAuth,
  asyncHandler(async (req, res) => {
    const stored = await getRepositories().users.findById(req.auth!.userId);
    if (!stored) throw ApiError.notFound("Account not found");
    res.json(await loyaltySummary(stored));
  }),
);

/**
 * Lets the client discover whether the SMS code is echoed back for the demo.
 * It never is in production — see the richer GET /api/config for new clients.
 */
authRouter.get("/config", (_req, res) => {
  res.json({ exposesPaymentCode: !env.isProduction, exposesPaymentOtp: !env.isProduction });
});
