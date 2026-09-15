import { SMS_CODE_TTL_SECONDS } from "../../../shared/pricing.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { smsProvider, smsProviderName } from "./sms/factory.js";

export interface SmsResult {
  delivered: boolean;
  provider: string;
  messageId?: string;
}

/**
 * Sends a confirmation code through the configured SMS gateway
 * (`SMS_PROVIDER`, legacy `SMS_PROVIDER_URL`, or the mock).
 *
 * In production the mock is refused outright — silently "delivering" codes
 * nowhere would lock every buyer out of their tickets.
 */
export async function sendSmsCode(phone: string, code: string): Promise<SmsResult> {
  const minutes = Math.round(SMS_CODE_TTL_SECONDS / 60);
  const text = `CineTickets: your payment code is ${code}. It expires in ${minutes} minutes. Never share it with anyone.`;
  const name = smsProviderName();

  if (name === "mock" && env.isProduction) {
    logger.error({ phone: maskPhone(phone) }, "SMS gateway is not configured; code not delivered");
    return { delivered: false, provider: "unconfigured" };
  }

  try {
    const result = await smsProvider().send(phone, text);
    if (result.delivered) {
      logger.info({ phone: maskPhone(phone), provider: name, messageId: result.messageId }, "SMS code sent");
    } else {
      logger.error({ phone: maskPhone(phone), provider: name }, "SMS provider failed to deliver the code");
    }
    return { delivered: result.delivered, provider: name, messageId: result.messageId };
  } catch (error) {
    // Misconfigured provider (missing credentials) or a broken gateway —
    // the caller maps this to "could not send the code, try again".
    logger.error({ err: error, phone: maskPhone(phone), provider: name }, "SMS send failed");
    return { delivered: false, provider: name };
  }
}

/** Keeps the last 4 digits only — phone numbers are never logged in full. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "+•••";
  const tail = digits.slice(-4);
  const country = phone.startsWith("+") ? phone.slice(0, digits.length > 10 ? 2 : 2) : "";
  return `${country}***-**-${tail}`;
}

/** UI-friendly mask, e.g. "+7 *** ***-45-67". */
export function maskPhoneForDisplay(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return "+••• •••-••-••";
  const prefix = phone.startsWith("+") ? `+${digits.slice(0, digits.length - 10)}` : "+";
  const tail = digits.slice(-4);
  return `${prefix} *** ***-${tail.slice(0, 2)}-${tail.slice(2)}`;
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `+${digits}`;
}
