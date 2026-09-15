import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { SMS_CODE_LENGTH } from "@shared/pricing";
import { cn } from "@/lib/cn";

export interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
}

/**
 * One input per digit with paste, arrow-key and backspace handling — the
 * original screen rendered four uncontrolled boxes that shared no state at all.
 */
export function OtpInput({
  value,
  onChange,
  length = SMS_CODE_LENGTH,
  disabled,
  autoFocus,
  invalid,
  ariaLabel,
}: OtpInputProps) {
  const { t } = useTranslation();
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (autoFocus) inputs.current[0]?.focus();
  }, [autoFocus]);

  const setDigit = (index: number, digit: string) => {
    const next = value.padEnd(length, " ").slice(0, length).split("");
    next[index] = digit || " ";
    onChange(next.join("").replace(/\s+$/, "").replace(/\s/g, ""));
  };

  const handleChange = (index: number, raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (digits.length > 1) {
      // Typing/pasting several digits at once fills forward.
      const next = (value.slice(0, index) + digits).slice(0, length);
      onChange(next);
      inputs.current[Math.min(index + digits.length, length - 1)]?.focus();
      return;
    }
    setDigit(index, digits);
    if (digits && index < length - 1) inputs.current[index + 1]?.focus();
  };

  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace") {
      event.preventDefault();
      if (value[index]) {
        setDigit(index, "");
      } else if (index > 0) {
        setDigit(index - 1, "");
        inputs.current[index - 1]?.focus();
      }
    } else if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      inputs.current[index - 1]?.focus();
    } else if (event.key === "ArrowRight" && index < length - 1) {
      event.preventDefault();
      inputs.current[index + 1]?.focus();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    if (!pasted) return;
    onChange(pasted);
    inputs.current[Math.min(pasted.length, length - 1)]?.focus();
  };

  return (
    <div
      className="flex justify-center gap-2 sm:gap-3"
      role="group"
      aria-label={ariaLabel ?? t("payment.codeInput")}
    >
      {Array.from({ length }, (_, index) => (
        <input
          key={index}
          ref={(element) => {
            inputs.current[index] = element;
          }}
          value={value[index] ?? ""}
          onChange={(event) => handleChange(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          onPaste={handlePaste}
          onFocus={(event) => event.currentTarget.select()}
          disabled={disabled}
          type="text"
          inputMode="numeric"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          maxLength={1}
          aria-label={t("payment.digitOf", { index: index + 1, length })}
          aria-invalid={invalid || undefined}
          className={cn(
            "h-14 w-11 rounded-xl border bg-ink-800 text-center text-2xl font-semibold text-white",
            "transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:h-16 sm:w-13",
            invalid ? "border-danger" : "border-white/20",
            disabled && "opacity-50",
          )}
        />
      ))}
    </div>
  );
}
