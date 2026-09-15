import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-brand-500 text-ink-950 font-semibold hover:bg-brand-400 active:bg-brand-600 shadow-[0_10px_30px_-12px_rgba(29,231,130,0.7)]",
  secondary: "border border-white/25 bg-white/5 text-white hover:border-white/60 hover:bg-white/10",
  ghost: "text-white/80 hover:bg-white/10 hover:text-white",
  // red-600 (not danger/red-500): white on #ef4444 is only 3.76:1 — below the
  // WCAG AA 4.5:1 for button labels. red-600 gives 4.8:1, hover red-700 6.5:1.
  danger: "bg-red-600 text-white font-semibold hover:bg-red-700",
  subtle: "bg-ink-700 text-white hover:bg-ink-600",
};

const SIZES: Record<Size, string> = {
  sm: "h-9 px-3 text-sm rounded-lg gap-1.5",
  md: "h-11 px-5 text-[15px] rounded-xl gap-2",
  lg: "h-13 px-7 text-base rounded-xl gap-2.5",
};

const BASE =
  "inline-flex items-center justify-center whitespace-nowrap transition-colors duration-150 " +
  "disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-brand-500 cursor-pointer";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    fullWidth,
    leftIcon,
    rightIcon,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      // Triple click protection: disabled while a request is in flight.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && "w-full", className)}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});

export interface ButtonLinkProps extends LinkProps {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

/** Same look as <Button>, but for navigation (renders a real anchor). */
export function ButtonLink({
  variant = "primary",
  size = "md",
  fullWidth,
  leftIcon,
  rightIcon,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && "w-full", className)} {...rest}>
      {leftIcon}
      {children}
      {rightIcon}
    </Link>
  );
}
