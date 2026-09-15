import { Router } from "express";
import { createPaymentIntentSchema, verifyPaymentSchema } from "../../../shared/schemas.js";
import { createIntent, getIntent, resendCode, verifyCode } from "../services/paymentService.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { paymentLimiter } from "../middleware/rateLimit.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { routeParam } from "../utils/http.js";

export const paymentsRouter: Router = Router();

paymentsRouter.use(requireAuth);

/**
 * Step 1: encrypted card details (or PayPal email) → 4-digit SMS challenge.
 * Card data arrives RSA-OAEP encrypted and is decrypted in memory only.
 */
paymentsRouter.post(
  "/intents",
  paymentLimiter,
  validate(createPaymentIntentSchema),
  asyncHandler(async (req, res) => {
    const result = await createIntent(req.auth!.userId, req.body);
    res.status(201).json({ payment: result.payment, smsDelivered: result.smsDelivered });
  }),
);

paymentsRouter.get(
  "/:paymentId",
  asyncHandler(async (req, res) => {
    res.json({ payment: await getIntent(routeParam(req, "paymentId"), req.auth!.userId) });
  }),
);

/** Step 2: verify the SMS code, charge via the PSP, settle the booking. */
paymentsRouter.post(
  "/:paymentId/verify",
  paymentLimiter,
  validate(verifyPaymentSchema),
  asyncHandler(async (req, res) => {
    const { payment, booking } = await verifyCode(routeParam(req, "paymentId"), req.body, req.auth!.userId);
    res.json({ payment, booking });
  }),
);

paymentsRouter.post(
  "/:paymentId/resend",
  paymentLimiter,
  asyncHandler(async (req, res) => {
    const { payment } = await resendCode(routeParam(req, "paymentId"), req.auth!.userId);
    res.json({ payment });
  }),
);
