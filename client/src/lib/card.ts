/** Card helpers shared by the checkout form. */
import type { CardBrand } from "@shared/types";

export function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/** Groups a card number in 4s (Amex uses 4-6-5). */
export function formatCardNumber(value: string): string {
  const digits = onlyDigits(value).slice(0, 19);
  const isAmex = /^3[47]/.test(digits);
  const groups = isAmex ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const parts: string[] = [];
  let index = 0;
  for (const size of groups) {
    if (index >= digits.length) break;
    parts.push(digits.slice(index, index + size));
    index += size;
  }
  return parts.join(" ");
}

export function formatExpiry(value: string): string {
  const digits = onlyDigits(value).slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

export function luhnValid(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Mir (2200–2204) is checked first: it also lives in the Mastercard range. */
export function cardBrand(value: string): CardBrand {
  const digits = onlyDigits(value);
  if (/^220[0-4]/.test(digits) && digits.length === 16) return "mir";
  if (/^4/.test(digits)) return "visa";
  if (/^(5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return "mastercard";
  if (/^3[47]/.test(digits)) return "amex";
  if (/^62/.test(digits)) return "unionpay";
  return "unknown";
}

export function maskCardNumber(value: string): string {
  const digits = onlyDigits(value);
  return `${"•".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/** Masked number in the card's own grouping, e.g. "•••• •••• •••• 4242". */
export function maskCardNumberGrouped(value: string): string {
  const digits = onlyDigits(value);
  if (digits.length <= 4) return digits;
  const isAmex = /^3[47]/.test(digits);
  const last4 = digits.slice(-4);
  const hidden = isAmex
    ? `${"•".repeat(6)} ${"•".repeat(5)}`
    : `${"•".repeat(4)} ${"•".repeat(4)} ${"•".repeat(4)}`;
  return `${hidden} ${last4}`;
}
