import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Gift, Sparkles, Ticket } from "lucide-react";
import { authApi } from "@/api/endpoints";
import { useToast } from "@/context/ToastContext";
import { Button } from "@/components/ui/Button";
import { useMoney } from "@/i18n/AppConfigProvider";
import { Skeleton } from "@/components/ui/Feedback";

/**
 * Bonus wallet + referral (ТЗ §2: BonusTransaction / Referral).
 * Points are stored in base-currency cents, so they format like money.
 */
export function LoyaltyCard() {
  const { t } = useTranslation();
  const { money } = useMoney();
  const { toast } = useToast();

  const query = useQuery({
    queryKey: ["loyalty"],
    queryFn: () => authApi.loyalty(),
    staleTime: 30_000,
  });

  if (query.isPending) {
    return <Skeleton className="mt-6 h-40 w-full rounded-2xl" />;
  }

  const data = query.data;
  if (!data) return null;
  const points = money(data.balanceCents);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(data.referral.code);
      toast({ title: t("loyalty.referralCopied"), variant: "success" });
    } catch {
      toast({
        title: data.referral.code,
        description: t("loyalty.referralCopy", { code: data.referral.code }),
      });
    }
  };

  return (
    <section
      aria-labelledby="account-loyalty-heading"
      className="mt-6 rounded-2xl border border-white/10 bg-ink-800/50 p-6"
    >
      <h2 id="account-loyalty-heading" className="flex items-center gap-2 text-lg font-semibold text-white">
        <Sparkles className="size-4 text-brand-400" aria-hidden />
        {t("loyalty.title")}
      </h2>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-xs uppercase tracking-wide text-white/55">{t("loyalty.balance")}</p>
          <p className="mt-1 text-xl font-semibold text-white">{points}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-xs uppercase tracking-wide text-white/55">{t("loyalty.earned")}</p>
          <p className="mt-1 text-lg text-white/85">{money(data.earnedCents)}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <p className="text-xs uppercase tracking-wide text-white/55">{t("loyalty.spent")}</p>
          <p className="mt-1 text-lg text-white/85">{money(data.spentCents)}</p>
        </div>
      </div>

      <div className="mt-5 rounded-xl border border-brand-500/25 bg-brand-500/5 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Gift className="size-4 text-brand-400" aria-hidden />
          {t("loyalty.referralTitle")}
        </h3>
        <p className="mt-1 text-sm text-white/70">
          {t("loyalty.referralCopy", { code: data.referral.code })}
        </p>
        <div className="mt-2 flex items-center gap-3">
          <code className="rounded-lg bg-ink-900 px-3 py-1.5 font-mono text-sm text-brand-200">
            {data.referral.code}
          </code>
          <Button size="sm" variant="secondary" onClick={() => void copyCode()}>
            {t("common.copy", { defaultValue: "Copy" })}
          </Button>
          <span className="text-xs text-white/50">
            {t("loyalty.referralInvited", { count: data.referral.invited })}
          </span>
        </div>
      </div>

      {data.transactions.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-sm font-semibold text-white">{t("loyalty.history")}</h3>
          <ul className="mt-2 divide-y divide-white/5 text-sm">
            {data.transactions.slice(0, 8).map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-2 text-white/75">
                  <Ticket className="size-4 text-white/35" aria-hidden />
                  {t(`loyalty.reason.${entry.reason}`, { defaultValue: entry.reason })}
                </span>
                <span className={entry.delta >= 0 ? "text-brand-300" : "text-white/60"}>
                  {entry.delta >= 0 ? "+" : "−"}
                  {money(Math.abs(entry.delta))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-4 text-sm text-white/50">{t("loyalty.empty")}</p>
      )}
    </section>
  );
}
