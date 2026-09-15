import { describe, expect, it } from "vitest";
import {
  cardBrand,
  formatCardNumber,
  formatExpiry,
  luhnValid,
  maskCardNumber,
  maskCardNumberGrouped,
} from "./card";

describe("card helpers", () => {
  it("groups digits in blocks of four", () => {
    expect(formatCardNumber("4242424242424242")).toBe("4242 4242 4242 4242");
    expect(formatCardNumber("4242424242")).toBe("4242 4242 42");
    expect(formatCardNumber("4242-4242")).toBe("4242 4242");
  });

  it("groups Amex numbers as 4-6-5", () => {
    expect(formatCardNumber("378282246310005")).toBe("3782 822463 10005");
  });

  it("formats expiry as MM/YY", () => {
    expect(formatExpiry("1230")).toBe("12/30");
    expect(formatExpiry("1")).toBe("1");
    expect(formatExpiry("12/30/99")).toBe("12/30");
  });

  it("validates the Luhn checksum", () => {
    expect(luhnValid("4242 4242 4242 4242")).toBe(true);
    expect(luhnValid("5555 5555 5555 4444")).toBe(true);
    expect(luhnValid("4242 4242 4242 4241")).toBe(false);
    expect(luhnValid("123")).toBe(false);
  });

  it("detects the brand and masks the number", () => {
    expect(cardBrand("4111 1111 1111 1111")).toBe("visa");
    expect(cardBrand("5555 5555 5555 4444")).toBe("mastercard");
    expect(cardBrand("3782 822463 10005")).toBe("amex");
    expect(cardBrand("2200 0000 0000 0004")).toBe("mir");
    expect(maskCardNumber("4242 4242 4242 4242")).toBe("••••••••••••4242");
    expect(maskCardNumberGrouped("4242 4242 4242 4242")).toBe("•••• •••• •••• 4242");
  });
});
