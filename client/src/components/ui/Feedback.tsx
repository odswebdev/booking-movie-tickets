import { useTranslation } from "react-i18next";
import { AlertCircle, Inbox, RefreshCw, WifiOff } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { ApiRequestError } from "@/api/http";
import { translateApiError } from "@/lib/errors";

export function Spinner({ className, label }: { className?: string; label?: string }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-2 text-sm text-white/60" role="status">
      <svg className={cn("size-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label ? <span>{label}</span> : <span className="sr-only">{t("common.loading")}</span>}
    </span>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cn("skeleton", className)} style={style} aria-hidden />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-6 py-14 text-center">
      <div className="text-white/40">{icon ?? <Inbox className="size-8" aria-hidden />}</div>
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      {description ? <p className="max-w-md text-sm text-white/60">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Maps any thrown value onto a message that is safe and useful to show. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    // The code is translated by the component layer; fall back to the API message.
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function ErrorState({
  error,
  onRetry,
  title,
  compact = false,
}: {
  error: unknown;
  onRetry?: (() => void) | undefined;
  title?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const offline = error instanceof ApiRequestError && error.isNetworkError;
  const message = offline
    ? t("common.networkError")
    : error instanceof ApiRequestError
      ? translateApiError(error, t)
      : errorMessage(error);

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-danger/25 bg-danger/5 text-center",
        compact ? "px-5 py-8" : "px-6 py-14",
      )}
      role="alert"
    >
      <div className="text-danger">
        {offline ? (
          <WifiOff className="size-8" aria-hidden />
        ) : (
          <AlertCircle className="size-8" aria-hidden />
        )}
      </div>
      <h3 className="text-lg font-semibold text-white">{title ?? t("common.errorTitle")}</h3>
      <p className="max-w-md text-sm text-white/70">{message}</p>
      {onRetry ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          leftIcon={<RefreshCw className="size-4" aria-hidden />}
        >
          {t("common.retry")}
        </Button>
      ) : null}
    </div>
  );
}

export function Alert({
  tone = "info",
  children,
  className,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  children: ReactNode;
  className?: string;
}) {
  const tones: Record<string, string> = {
    info: "border-white/15 bg-white/5 text-white/80",
    warning: "border-warning/30 bg-warning/10 text-amber-100",
    danger: "border-danger/30 bg-danger/10 text-red-100",
    success: "border-brand-500/30 bg-brand-500/10 text-brand-300",
  };
  return (
    <div className={cn("rounded-xl border px-4 py-3 text-sm", tones[tone], className)} role="status">
      {children}
    </div>
  );
}
