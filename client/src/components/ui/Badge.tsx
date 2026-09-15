import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "neutral" | "brand" | "danger" | "warning" | "success";

const TONES: Record<Tone, string> = {
  neutral: "border-white/20 bg-white/5 text-white/70",
  brand: "border-brand-500/40 bg-brand-500/10 text-brand-300",
  danger: "border-danger/40 bg-danger/10 text-red-200",
  warning: "border-warning/40 bg-warning/10 text-amber-200",
  success: "border-brand-500/40 bg-brand-500/15 text-brand-300",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
