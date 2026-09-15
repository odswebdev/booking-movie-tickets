import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { CardBrand } from "../../../shared/types.js";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

/** scrypt with a per-user salt. `node:crypto` only — no native build step. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(plain.normalize("NFKC"), salt, KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const derived = await scryptAsync(plain.normalize("NFKC"), Buffer.from(saltHex, "hex"), KEY_LENGTH);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Luhn checksum — used to reject mistyped card numbers before any PSP call. */
export function luhnValid(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function detectCardBrand(cardNumber: string): CardBrand {
  const digits = cardNumber.replace(/\D/g, "");
  // Mir BIN ranges 2200–2204 (16 digits) — checked before Mastercard's 2-series.
  if (/^220[0-4]/.test(digits) && digits.length === 16) return "mir";
  if (/^4/.test(digits)) return "visa";
  if (/^(5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return "mastercard";
  if (/^3[47]/.test(digits)) return "amex";
  if (/^62/.test(digits)) return "unionpay";
  return "unknown";
}

export function cardLast4(cardNumber: string): string {
  return cardNumber.replace(/\D/g, "").slice(-4);
}

/** Rejects expired cards and anything more than 20 years out. */
export function cardExpiryValid(expiry: string, now: Date = new Date()): boolean {
  const match = expiry.match(/^(\d{2})\s*\/\s*(\d{2})$/);
  if (!match) return false;
  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  if (month < 1 || month > 12) return false;
  if (year > now.getUTCFullYear() + 20) return false;
  const expiringAfter = new Date(Date.UTC(year, month, 1)); // exclusive: valid through end of month
  return expiringAfter.getTime() > now.getTime();
}
