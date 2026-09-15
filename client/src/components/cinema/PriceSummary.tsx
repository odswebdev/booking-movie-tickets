import { useTranslation } from "react-i18next";
import type { Quote } from "@shared/types";
import { SERVICE_FEE_RATE } from "@shared/pricing";
import { seatClassLabel } from "@/lib/localize";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { cn } from "@/lib/cn";

export function PriceSummary({
  quote,
  title,
  className,
  footer,
}: {
  quote: Quote;
  title?: string;
  className?: string;
  footer?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { money, config } = useAppConfig();

  return (
    <div className={cn("rounded-2xl border border-white/10 bg-white/[0.03] p-5", className)}>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
        {title ?? t("checkout.orderSummary")}
      </h2>

      <ul className="mt-4 space-y-2 text-sm">
        {quote.lines.map((line) => (
          <li key={line.seatId} className="flex items-baseline justify-between gap-3">
            <span className="text-white/80">
              {t("seats.seat")} {line.label}
              <span className="ml-2 text-xs text-white/55">{seatClassLabel(line.seatClass, t)}</span>
            </span>
            <span className="tabular-nums text-white/90">{money(line.priceCents)}</span>
          </li>
        ))}
      </ul>

      <dl className="mt-4 space-y-2 border-t border-white/10 pt-4 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-white/60">
            {t("price.subtotal")} ({t("price.tickets", { count: quote.lines.length })})
          </dt>
          <dd className="tabular-nums text-white/90">{money(quote.subtotalCents)}</dd>
        </div>
        {quote.discountCents > 0 ? (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-brand-300">
              {t("price.discount")}
              {quote.promoCode ? ` · ${quote.promoCode}` : ""}
              {quote.discountPercent ? ` −${quote.discountPercent}%` : ""}
            </dt>
            <dd className="tabular-nums text-brand-300">−{money(quote.discountCents)}</dd>
          </div>
        ) : null}
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-white/60">
            {t("price.serviceFee", {
              percent: Math.round((config.serviceFeeRate || SERVICE_FEE_RATE) * 100),
            })}
          </dt>
          <dd className="tabular-nums text-white/90">{money(quote.serviceFeeCents)}</dd>
        </div>
        <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-white/10 pt-3">
          <dt className="text-base font-semibold text-white">{t("price.total")}</dt>
          <dd className="text-xl font-semibold tabular-nums text-brand-400">{money(quote.totalCents)}</dd>
        </div>
      </dl>

      {footer ? <div className="mt-5">{footer}</div> : null}
    </div>
  );
}
