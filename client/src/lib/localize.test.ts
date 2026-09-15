import { describe, expect, it } from "vitest";
import { formatMoneyForLocale } from "@shared/pricing";
import { formatDuration, movieText } from "./localize";
import { formatPhoneInput, normalizePhone, isValidPhone } from "./phone";

describe("money follows the UI language", () => {
  it("renders USD for English", () => {
    expect(formatMoneyForLocale(1200, "en")).toBe("$12.00");
  });

  it("renders RUB for Russian (converted at the shared FX rate)", () => {
    // 1200 base cents x 90 = 108 000 RUB cents = 1 080 RUB
    expect(formatMoneyForLocale(1200, "ru").replace(/\s/g, " ")).toBe("1 080 ₽");
  });
});

describe("movie text", () => {
  it("falls back to the original title when no translation exists", () => {
    const movie = { title: "Dune: Part Two", localized: undefined };
    expect(movieText(movie, "ru").title).toBe("Dune: Part Two");
  });

  it("uses the translated copy when present", () => {
    const movie = {
      title: "Dune: Part Two",
      synopsis: "Paul unites with the Fremen.",
      localized: { ru: { title: "Дюна: Часть вторая", synopsis: "Пол объединяется с фрименами." } },
    };
    expect(movieText(movie, "ru")).toEqual({
      title: "Дюна: Часть вторая",
      synopsis: "Пол объединяется с фрименами.",
    });
  });
});

describe("duration", () => {
  it("uses English suffixes in English", () => {
    expect(formatDuration(148, "en")).toBe("2h 28m");
    expect(formatDuration(95, "en")).toBe("1h 35m");
  });

  it("uses Russian suffixes in Russian", () => {
    expect(formatDuration(148, "ru")).toBe("2 ч 28 мин");
    expect(formatDuration(45, "ru")).toBe("45 мин");
  });
});

describe("phone numbers", () => {
  it("masks Russian numbers as +7 (XXX) XXX-XX-XX", () => {
    expect(formatPhoneInput("79161234567")).toBe("+7 (916) 123-45-67");
  });

  it("masks US numbers as +1 (XXX) XXX-XXXX", () => {
    expect(formatPhoneInput("12025550123")).toBe("+1 (202) 555-0123");
  });

  it("normalises to E.164 and validates", () => {
    expect(normalizePhone("+7 (916) 123-45-67")).toBe("+79161234567");
    expect(isValidPhone("+7 (916) 123-45-67")).toBe(true);
    expect(isValidPhone("123")).toBe(false);
  });
});
