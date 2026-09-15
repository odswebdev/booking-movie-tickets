import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | undefined;
  hint?: string;
  /** Hides the visible label but keeps it for screen readers. */
  hideLabel?: boolean;
  leftAddon?: ReactNode;
  rightAddon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, hideLabel, leftAddon, rightAddon, className, id, ...rest },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  return (
    <div className="w-full">
      <label
        htmlFor={inputId}
        className={cn("mb-1.5 block text-sm font-medium text-white/80", hideLabel && "sr-only")}
      >
        {label}
      </label>

      <div className="relative flex items-center">
        {leftAddon ? (
          <span className="pointer-events-none absolute left-3 text-white/50" aria-hidden>
            {leftAddon}
          </span>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className={cn(
            "h-11 w-full rounded-xl border bg-ink-800 px-3.5 text-[15px] text-white",
            "placeholder:text-white/50 transition-colors",
            "focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30",
            error ? "border-danger focus:border-danger focus:ring-danger/30" : "border-white/15",
            leftAddon ? "pl-10" : undefined,
            rightAddon ? "pr-12" : undefined,
            className,
          )}
          {...rest}
        />
        {rightAddon ? (
          <span className="absolute right-3 flex items-center text-white/60">{rightAddon}</span>
        ) : null}
      </div>

      {error ? (
        <p id={errorId} className="mt-1.5 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mt-1.5 text-sm text-white/50">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
