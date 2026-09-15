import { z } from "zod";
import { MAX_SEATS_PER_BOOKING, SMS_CODE_LENGTH } from "./pricing.js";

/** Password rules are shared so the register form and the API agree. */
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be at most 72 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/\d/, "Password must contain a number");

export const emailSchema = z
  .string()
  .trim()
  .min(1, "Email is required")
  .max(254, "Email is too long")
  .email("Enter a valid email address")
  .transform((value) => value.toLowerCase());

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, "Name must be at least 2 characters").max(60, "Name is too long"),
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    /** Optional loyalty invite code (credits both sides with bonus points). */
    referralCode: z.string().trim().min(4).max(16).optional(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10, "Refresh token is required"),
});

/** E.164-ish phone number: digits only, 10–15 after a optional leading +. */
export const phoneSchema = z
  .string()
  .trim()
  .min(10, "Enter your phone number")
  .max(20, "Phone number is too long")
  .transform((value) => value.replace(/[^\d+]/g, ""))
  .refine((value) => /^\+?\d{10,15}$/.test(value), "Enter a valid phone number");

export const seatSelectionSchema = z.object({
  seatIds: z
    .array(z.string().min(2).max(4))
    .min(1, "Select at least one seat")
    .max(MAX_SEATS_PER_BOOKING, `You can select up to ${MAX_SEATS_PER_BOOKING} seats`)
    .transform((ids) => [...new Set(ids)]),
});

export const createBookingSchema = z.object({
  showtimeId: z.string().min(1, "Showtime is required"),
  seatIds: z
    .array(z.string().min(2).max(4))
    .min(1, "Select at least one seat")
    .max(MAX_SEATS_PER_BOOKING, `You can select up to ${MAX_SEATS_PER_BOOKING} seats`)
    .transform((ids) => [...new Set(ids)]),
  /** Guest checkout token: lets an anonymous user keep their seat hold. */
  holdToken: z.string().min(8).optional(),
  promoCode: z.string().trim().max(24).optional(),
  /** Loyalty points to redeem (clamped server side to the live balance). */
  bonusCents: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

/** Review form: 1–10 score plus a short text. */
export const reviewSchema = z.object({
  rating: z.coerce.number().int().min(1, "Score at least 1").max(10, "Score at most 10"),
  text: z.string().trim().min(3, "Please write a few words").max(600, "Review is too long"),
});

/** Passwordless sign-in: request a magic link / consume its token. */
export const magicLinkRequestSchema = z.object({ email: emailSchema });
export const magicLinkVerifySchema = z.object({ token: z.string().min(16, "Magic link token is required") });

/** Guest checkout: booking is created for a lightweight account. */
export const guestCheckoutSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(60),
  email: emailSchema,
  phone: phoneSchema.optional(),
});

/** Guest checkout request: contact details + the regular booking payload. */
export const guestBookingSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(60),
  email: emailSchema,
  phone: phoneSchema.optional(),
  showtimeId: z.string().min(1, "Showtime is required"),
  seatIds: z
    .array(z.string().min(2).max(4))
    .min(1, "Select at least one seat")
    .max(MAX_SEATS_PER_BOOKING, `You can select up to ${MAX_SEATS_PER_BOOKING} seats`)
    .transform((ids) => [...new Set(ids)]),
  holdToken: z.string().min(8).optional(),
  promoCode: z.string().trim().max(24).optional(),
  bonusCents: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

/** Claiming a guest account: set a password to keep the tickets. */
export const claimGuestSchema = z.object({
  guestToken: z.string().min(16, "Guest token is required"),
  password: passwordSchema,
});

/** Decrypted card payload — never accepted in plain text from the browser. */
export const decryptedCardSchema = z.object({
  number: z.string().min(12, "Card number is incomplete").max(19, "Card number is invalid"),
  name: z.string().trim().min(2, "Cardholder name is required").max(60),
  expiry: z.string().regex(/^(0[1-9]|1[0-2])\s?\/\s?\d{2}$/, "Use MM/YY"),
  cvc: z.string().regex(/^\d{3,4}$/, "CVC must be 3 or 4 digits"),
});

export const createPaymentIntentSchema = z
  .object({
    bookingId: z.string().min(1, "Booking is required"),
    method: z.enum(["card", "paypal"]),
    phone: phoneSchema,
    /**
     * Either the raw PAN encrypted in the browser with the API's public key,
     * or a token produced by the PSP's PCI widget (Checkout.js / Stripe
     * Elements) — the widget path never sends card data to our server.
     */
    card: z
      .union([
        z.object({
          keyId: z.string().min(1, "Missing encryption key id"),
          encrypted: z.string().min(16, "Missing encrypted card payload"),
        }),
        z.object({
          provider: z.enum(["yookassa", "stripe"]),
          token: z.string().min(8, "Missing tokenized card payload"),
          wallet: z.enum(["apple_pay", "google_pay"]).optional(),
          brand: z.string().max(32).optional(),
          last4: z
            .string()
            .regex(/^\d{4}$/, "Enter the last four digits")
            .optional(),
        }),
      ])
      .optional(),
    paypal: z
      .object({
        email: emailSchema,
      })
      .optional(),
  })
  .refine((data) => (data.method === "card" ? Boolean(data.card) : Boolean(data.paypal)), {
    path: ["method"],
    message: "Select a payment method and fill in its details",
  });

export const verifyPaymentSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d+$/, "Enter digits only")
    .length(SMS_CODE_LENGTH, `Enter the ${SMS_CODE_LENGTH}-digit code`),
});

export const promoCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(3, "Promo code is too short")
    .max(24, "Promo code is too long")
    .transform((value) => value.toUpperCase()),
  seatCount: z.coerce.number().int().min(1).max(MAX_SEATS_PER_BOOKING).optional(),
  subtotalCents: z.coerce.number().int().min(0).optional(),
});

export const bookingIdParamSchema = z.object({
  bookingId: z.string().min(1),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentSchema>;
export type DecryptedCard = z.infer<typeof decryptedCardSchema>;
