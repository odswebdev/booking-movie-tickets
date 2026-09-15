import { z } from "zod";
import { emailSchema, passwordSchema } from "@shared/schemas";
import { SMS_CODE_LENGTH } from "@shared/pricing";
import { luhnValid, onlyDigits } from "./card";
import { isValidPhone } from "./phone";

/**
 * Form schemas are built per-render through `t`, so every validation message
 * follows the active language. The server re-validates everything: client-side
 * rules are UX only, never a security boundary.
 */
type Translate = (key: string, options?: Record<string, unknown>) => string;

export function createAuthSchemas(t: Translate) {
  const login = z.object({
    email: emailSchema,
    password: z.string().min(1, t("auth.passwordRequired")),
  });

  const register = z
    .object({
      name: z.string().trim().min(2, t("auth.nameTooShort")).max(60, t("auth.nameTooLong")),
      email: emailSchema,
      password: passwordSchema,
      confirmPassword: z.string(),
      /** Referral / invite code (ТЗ §2: Referral) — optional. */
      referralCode: z
        .string()
        .trim()
        .toUpperCase()
        .max(16, t("auth.referralInvalid"))
        .optional()
        .or(z.literal("")),
    })
    .refine((data) => data.password === data.confirmPassword, {
      path: ["confirmPassword"],
      message: t("auth.passwordMismatch"),
    });

  return { login, register };
}

export function createCardSchema(t: Translate) {
  return z.object({
    number: z
      .string()
      .min(1, t("payment.cardNumberRequired"))
      .refine((value) => onlyDigits(value).length >= 12, t("payment.cardNumberIncomplete"))
      .refine(luhnValid, t("payment.cardNumberInvalid")),
    name: z.string().trim().min(2, t("payment.cardNameRequired")).max(60, t("payment.cardNameTooLong")),
    expiry: z
      .string()
      .regex(/^\d{2}\/\d{2}$/, t("payment.expiryFormat"))
      .refine((value) => {
        const [month, year] = value.split("/").map(Number) as [number, number];
        if (month < 1 || month > 12) return false;
        const expiresAt = new Date(Date.UTC(2000 + year, month, 1));
        return expiresAt.getTime() > Date.now();
      }, t("payment.cardExpired")),
    cvc: z.string().regex(/^\d{3,4}$/, t("payment.cvcInvalid")),
  });
}

export function createPhoneSchema(t: Translate) {
  return z.object({
    phone: z.string().min(1, t("payment.phoneRequired")).refine(isValidPhone, t("payment.phoneInvalid")),
  });
}

export function createPaypalSchema(t: Translate) {
  return z.object({
    email: z.string().trim().min(1, t("payment.paypalEmailRequired")).email(t("payment.paypalEmailInvalid")),
  });
}

export function createCodeSchema(t: Translate, length: number = SMS_CODE_LENGTH) {
  return z.object({
    code: z
      .string()
      .regex(/^\d*$/, t("payment.codeDigitsOnly"))
      .refine((value) => value.length === length, t("payment.codeLength", { count: length })),
  });
}

type AuthSchemas = ReturnType<typeof createAuthSchemas>;
export type LoginFormValues = z.infer<AuthSchemas["login"]>;
export type RegisterFormValues = z.infer<AuthSchemas["register"]>;
export type CardFormValues = z.infer<ReturnType<typeof createCardSchema>>;
export type PhoneFormValues = z.infer<ReturnType<typeof createPhoneSchema>>;
export type PaypalFormValues = z.infer<ReturnType<typeof createPaypalSchema>>;
export type CodeFormValues = z.infer<ReturnType<typeof createCodeSchema>>;
