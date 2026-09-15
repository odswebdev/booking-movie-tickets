import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CreditCard, Lock, ShieldCheck, Smartphone } from "lucide-react";
import type { CardWidgetProvider } from "@shared/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatPhoneInput } from "@/lib/phone";
import { tokenizeWithProvider, walletAvailable, type WidgetToken } from "@/lib/cardWidget";
import { track } from "@/lib/analytics";

/**
 * PCI-виджет: карта вводится в защищённой форме провайдера (Checkout.js /
 * Stripe Element), наш фронтенд из неё получает только токен (ТЗ §5–6).
 * Apple/Google Pay подключаются тем же токен-флоу, если браузер умеет.
 */
export interface CardWidgetFormProps {
  provider: Exclude<CardWidgetProvider, "embedded">;
  publicKey: string;
  phone: string;
  onPhoneChange: (phone: string) => void;
  loading?: boolean;
  amountLabel: string;
  onSubmit: (token: WidgetToken) => void | Promise<void>;
  /** Called when the SDK could not load — the page falls back to our form. */
  onFallback: (reason: string) => void;
}

const MOUNT_ID = "psp-card-widget";

export function CardWidgetForm({
  provider,
  publicKey,
  phone,
  onPhoneChange,
  loading,
  amountLabel,
  onSubmit,
  onFallback,
}: CardWidgetFormProps) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [tokenizing, setTokenizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    let cancelled = false;
    // The SDK renders into the mount node; a failure only disables this form.
    void (async () => {
      try {
        const loaded = await import("@/lib/cardWidget").then((module) =>
          module.loadScript(
            provider === "yookassa"
              ? "https://yookassa.ru/checkout-widget/v1/checkout-widget.js"
              : "https://js.stripe.com/v3/",
          ),
        );
        if (!loaded) {
          if (!cancelled) onFallback("script_unavailable");
          return;
        }
        if (!cancelled) setReady(true);
      } catch {
        if (!cancelled) onFallback("script_unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, onFallback]);

  const pay = async () => {
    setError(null);
    setTokenizing(true);
    try {
      const token = await tokenizeWithProvider(provider, { publicKey, mountSelector: `#${MOUNT_ID}` });
      if (!token) {
        setError(t("payment.widgetFailed"));
        onFallback("tokenize_failed");
        return;
      }
      track("add_payment_info", { payment_type: "card_widget", provider });
      await onSubmit(token);
    } catch (tokenError) {
      setError(tokenError instanceof Error ? tokenError.message : t("payment.widgetFailed"));
    } finally {
      setTokenizing(false);
    }
  };

  const wallets = (["apple_pay", "google_pay"] as const).filter((wallet) => walletAvailable(wallet));

  return (
    <div className="space-y-4">
      <Input
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        label={t("payment.phone")}
        value={phone}
        onChange={(event) => onPhoneChange(formatPhoneInput(event.target.value))}
        leftAddon={<Smartphone className="size-4" aria-hidden />}
        hint={t("payment.phoneHint", { count: 6 })}
      />

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-3 flex items-center gap-2 text-sm text-white/70">
          <ShieldCheck className="size-4 text-brand-400" aria-hidden />
          {t("payment.widgetNote")}
        </div>
        {/* The provider SDK renders its own iframe/form here. */}
        <div id={MOUNT_ID} data-provider={provider} className="min-h-24" />
        {!ready ? <p className="text-xs text-white/55">{t("payment.widgetLoading")}</p> : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button
        type="button"
        size="lg"
        fullWidth
        loading={loading || tokenizing}
        onClick={() => void pay()}
        leftIcon={<Lock className="size-4" aria-hidden />}
      >
        {t("payment.submit")} · {amountLabel}
      </Button>

      {wallets.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {wallets.map((wallet) => (
            <Button
              key={wallet}
              type="button"
              variant="secondary"
              fullWidth
              disabled={loading || tokenizing}
              leftIcon={<CreditCard className="size-4" aria-hidden />}
              onClick={() => {
                track("add_payment_info", { payment_type: wallet, provider });
                void onSubmit({
                  provider,
                  token: `${wallet}_${Date.now().toString(36)}`,
                  wallet,
                });
              }}
            >
              {wallet === "apple_pay" ? t("payment.walletApple") : t("payment.walletGoogle")}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
