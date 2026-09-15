/** Phone number helpers: input masks that follow the country prefix. */

export function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

interface MaskRule {
  /** Country calling code, e.g. "7" for Russia or "1" for the US. */
  countryCode: string;
  totalDigits: number;
  /** Receives digits *without* the country code and returns the national part. */
  format: (national: string) => string;
}

const MASKS: MaskRule[] = [
  {
    countryCode: "7",
    totalDigits: 11,
    // +7 (916) 123-45-67
    format: (national) => {
      const parts = [national.slice(0, 3), national.slice(3, 6), national.slice(6, 8), national.slice(8, 10)];
      let result = parts[0] ?? "";
      if (parts[1]) result = `(${result}) ${parts[1]}`;
      if (parts[2]) result = `${result}-${parts[2]}`;
      if (parts[3]) result = `${result}-${parts[3]}`;
      return result;
    },
  },
  {
    countryCode: "1",
    totalDigits: 11,
    // +1 (202) 555-0123
    format: (national) => {
      const area = national.slice(0, 3);
      const rest = national.slice(3);
      if (!rest) return area;
      return `(${area}) ${rest.slice(0, 3)}${rest.length > 3 ? `-${rest.slice(3)}` : ""}`;
    },
  },
  {
    countryCode: "44",
    totalDigits: 12,
    // +44 7911 123456
    format: (national) => {
      const parts = [national.slice(0, 4), national.slice(4)].filter(Boolean);
      return parts.join(" ");
    },
  },
];

function defaultMask(digits: string): string {
  const parts: string[] = [];
  for (let index = 0; index < digits.length; index += 3) {
    parts.push(digits.slice(index, index + 3));
  }
  return parts.join(" ");
}

/** Formats as the user types: "+7 (916) 123-45-67" / "+1 (202) 555-0123". */
export function formatPhoneInput(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  const digits = onlyDigits(raw).slice(0, 15);
  if (!digits) return raw.startsWith("+") ? "+" : "";

  const rule = MASKS.find((candidate) => digits.startsWith(candidate.countryCode));
  if (!rule) return `+${defaultMask(digits)}`;

  const capped = digits.slice(0, rule.totalDigits);
  return `+${rule.countryCode} ${rule.format(capped.slice(rule.countryCode.length))}`.trimEnd();
}

/** E.164 ("+79161234567") for the API. */
export function normalizePhone(value: string): string {
  const digits = onlyDigits(value);
  return digits ? `+${digits}` : "";
}

export function isValidPhone(value: string): boolean {
  const digits = onlyDigits(value);
  return digits.length >= 10 && digits.length <= 15;
}
