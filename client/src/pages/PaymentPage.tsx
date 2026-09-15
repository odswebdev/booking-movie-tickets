import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  CreditCard,
  ExternalLink,
  Lock,
  Mail,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { SMS_RESEND_COOLDOWN_SECONDS } from "@shared/pricing";
import type { Booking, PaymentMethod, PaymentPublicKey } from "@shared/types";
import { bookingsApi, configApi, paymentsApi } from "@/api/endpoints";
import { queryKeys } from "@/api/queryKeys";
import { useToast } from "@/context/ToastContext";
import { useCountdown } from "@/hooks/useCountdown";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { formatCountdown } from "@/lib/localize";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { translateApiError } from "@/lib/errors";
import { track } from "@/lib/analytics";
import { encryptCardPayload, encryptionAvailable } from "@/lib/cardCrypto";
import { formatPhoneInput, normalizePhone } from "@/lib/phone";
import { createCodeSchema, createPaypalSchema, createPhoneSchema } from "@/lib/validation";
import { CardForm } from "@/components/cinema/CardForm";
import { CardWidgetForm } from "@/components/cinema/CardWidgetForm";
import type { WidgetToken } from "@/lib/cardWidget";
import { isValidPhone } from "@/lib/phone";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { OtpInput } from "@/components/ui/OtpInput";
import { Alert, ErrorState, Skeleton } from "@/components/ui/Feedback";
import { cn } from "@/lib/cn";

export default function PaymentPage() {
  const { t } = useTranslation();
  const { money, config, cardBrands } = useAppConfig();
  const { bookingId = "" } = useParams<{ bookingId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [method, setMethod] = useState<PaymentMethod>("card");
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [resendAvailableAt, setResendAvailableAt] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(
    (location.state as { devCode?: string } | null)?.devCode ?? null,
  );
  // Resend cooldown is driven by the same countdown hook as the seat hold —
  // computed here so the hook is never called conditionally.
  const resendRemainingMs = useCountdown(resendAvailableAt);

  useDocumentTitle(t("payment.method"));

  const paymentQuery = useQuery({
    queryKey: ["payments", paymentId],
    queryFn: () => paymentsApi.get(paymentId ?? ""),
    enabled: Boolean(paymentId),
    staleTime: 0,
  });

  // While the PSP waits for an off-site step, the booking is polled: the
  // provider webhook confirms it in the background and the page below
  // auto-advances to the ticket as soon as that happens.
  const awaitingProvider = paymentQuery.data?.payment.status === "requires_action";

  const bookingQuery = useQuery({
    queryKey: queryKeys.booking(bookingId),
    queryFn: () => bookingsApi.get(bookingId),
    enabled: bookingId.length > 0,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: awaitingProvider ? 5000 : false,
  });

  const booking: Booking | undefined = bookingQuery.data?.booking;
  const payment = paymentQuery.data?.payment;

  // A provider-side decline (or the OTP attempts running out) flips the
  // intent to `failed`; report it once per intent (ТЗ §10: payment_failed).
  const failedTrackedFor = useRef<string | null>(null);
  useEffect(() => {
    if (payment?.status === "failed" && payment.id !== failedTrackedFor.current) {
      failedTrackedFor.current = payment.id;
      track("payment_failed", {
        booking_id: bookingId,
        payment_id: payment.id,
        method: payment.method,
        stage: "provider",
      });
    }
  }, [payment, bookingId]);

  useEffect(() => {
    if (booking && booking.status !== "pending") {
      navigate(`/tickets/${booking.id}`, { replace: true });
    }
  }, [booking, navigate]);

  const startMutation = useMutation({
    mutationFn: async (input: { phone: string; card?: CardValues; widget?: WidgetToken; email?: string }) => {
      const payload: Parameters<typeof paymentsApi.createIntent>[0] = {
        bookingId,
        method,
        phone: normalizePhone(input.phone),
      };

      if (method === "card" && input.widget) {
        // PCI widget: the browser tokenized the card, our API only sees the
        // token (ТЗ §5–6). No card data leaves the provider's iframe.
        payload.card = {
          provider: input.widget.provider,
          token: input.widget.token,
          wallet: input.widget.wallet,
          brand: input.widget.cardBrand,
          last4: input.widget.cardLast4,
        };
      } else if (method === "card" && input.card) {
        if (!encryptionAvailable()) throw new Error("SECURE_CONTEXT_REQUIRED");
        const key: PaymentPublicKey = await configApi.paymentKey();
        payload.card = {
          keyId: key.keyId,
          // The number, name and CVC are encrypted here and only decrypted
          // inside the API process — they never travel in clear text.
          encrypted: await encryptCardPayload(
            {
              number: input.card.number.replace(/\s/g, ""),
              name: input.card.name,
              expiry: input.card.expiry,
              cvc: input.card.cvc,
            },
            key.publicKey,
          ),
        };
      } else if (method === "paypal" && input.email) {
        payload.paypal = { email: input.email };
      }

      return paymentsApi.createIntent(payload);
    },
    onSuccess: ({ payment: intent }) => {
      setPaymentId(intent.id);
      setResendAvailableAt(new Date(Date.now() + SMS_RESEND_COOLDOWN_SECONDS * 1000).toISOString());
      if (intent.devCode) setDevCode(intent.devCode);
      track("sms_code_sent", { payment_id: intent.id, method, resent: false });
      toast({
        title: t("payment.sentTo", { phone: intent.phoneMasked ?? "" }),
        variant: "success",
      });
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error && error.message === "SECURE_CONTEXT_REQUIRED"
          ? t("payment.securityWarning")
          : translateApiError(error, t);
      track("payment_failed", { booking_id: bookingId, method, stage: "intent" });
      toast({ title: t("payment.startFailed"), description: message, variant: "error" });
    },
  });

  const verifyMutation = useMutation({
    mutationFn: (code: string) => paymentsApi.verify(paymentId ?? "", code),
    onSuccess: ({ booking: paid }) => {
      queryClient.setQueryData(queryKeys.booking(bookingId), { booking: paid });
      void queryClient.invalidateQueries({ queryKey: ["bookings"] });
      track("sms_code_verified", { payment_id: paymentId, booking_id: bookingId });
      if (paid.status === "confirmed") {
        navigate(`/payment-success/${bookingId}`, { replace: true });
      } else {
        // The PSP needs an off-site step (3-D Secure, PayPal approval):
        // re-read the intent (it now carries the action URL) and show it.
        void paymentQuery.refetch();
        void bookingQuery.refetch();
        toast({ title: t("payment.actionNeeded"), variant: "info" });
      }
    },
    onError: (error: unknown) => {
      toast({
        title: t("payment.verifyFailed"),
        description: translateApiError(error, t),
        variant: "error",
      });
      void paymentQuery.refetch();
    },
  });

  const resendMutation = useMutation({
    mutationFn: () => paymentsApi.resend(paymentId ?? ""),
    onSuccess: ({ payment: intent }) => {
      // The server rotates the code and resets attempts/TTL: publish the fresh
      // intent, otherwise the code step keeps showing the superseded code.
      queryClient.setQueryData(["payments", paymentId], { payment: intent });
      setResendAvailableAt(new Date(Date.now() + SMS_RESEND_COOLDOWN_SECONDS * 1000).toISOString());
      if (intent.devCode) setDevCode(intent.devCode);
      track("sms_code_sent", { payment_id: intent.id, method, resent: true });
      toast({
        title: t("payment.newCodeSent"),
        description: t("payment.newCodeSentDescription"),
        variant: "success",
      });
    },
    onError: () => {
      toast({
        title: t("payment.resendFailed"),
        description: t("payment.resendFailedDescription"),
        variant: "error",
      });
    },
  });

  if (bookingQuery.isPending) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-12 sm:px-6">
        <Skeleton className="h-96 rounded-2xl" />
      </div>
    );
  }

  if (bookingQuery.isError || !booking) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-16 sm:px-6">
        <ErrorState
          error={bookingQuery.error}
          onRetry={() => void bookingQuery.refetch()}
          title={t("payment.loadError")}
        />
      </div>
    );
  }

  const amountLabel = money(booking.quote.totalCents);

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-white sm:text-3xl">{t("payment.method")}</h1>
        <p className="mt-1.5 text-sm text-white/60">
          {t("checkout.reference")} <span className="font-mono text-white/80">{booking.code}</span> ·{" "}
          {amountLabel}
        </p>
      </header>

      {payment && payment.status === "requires_action" ? (
        <ActionStep
          provider={payment.provider}
          actionUrl={payment.actionUrl ?? null}
          amountLabel={amountLabel}
          onCheck={async () => {
            const [bookingResult] = await Promise.all([bookingQuery.refetch(), paymentQuery.refetch()]);
            if (bookingResult.data?.booking.status === "confirmed") {
              navigate(`/payment-success/${bookingId}`, { replace: true });
            } else {
              toast({ title: t("payment.stillProcessing"), variant: "info" });
            }
          }}
          onBack={() => {
            setPaymentId(null);
            setDevCode(null);
          }}
        />
      ) : payment && payment.status === "requires_code" ? (
        <CodeStep
          amountLabel={amountLabel}
          phoneMasked={payment.phoneMasked}
          attemptsLeft={payment.attemptsLeft}
          expiresAt={payment.expiresAt}
          devCode={config.exposesPaymentCode ? (payment.devCode ?? devCode) : null}
          verifying={verifyMutation.isPending}
          resendRemainingMs={resendRemainingMs}
          onResend={() => resendMutation.mutate()}
          resending={resendMutation.isPending}
          onSubmit={(code) => verifyMutation.mutate(code)}
          onBack={() => {
            setPaymentId(null);
            setDevCode(null);
          }}
        />
      ) : (
        <MethodStep
          method={method}
          brands={cardBrands}
          onMethodChange={setMethod}
          amountLabel={amountLabel}
          loading={startMutation.isPending}
          secure={encryptionAvailable()}
          onSubmit={(input) => startMutation.mutate(input)}
        />
      )}

      <p className="mt-6 flex items-center justify-center gap-2 text-center text-xs text-white/50">
        <ShieldCheck className="size-4" aria-hidden />
        {t("payment.secureNote")}
      </p>
    </div>
  );
}

interface CardValues {
  number: string;
  name: string;
  expiry: string;
  cvc: string;
}

function MethodStep({
  method,
  brands,
  onMethodChange,
  amountLabel,
  loading,
  secure,
  onSubmit,
}: {
  method: PaymentMethod;
  brands: string[];
  onMethodChange: (method: PaymentMethod) => void;
  amountLabel: string;
  loading: boolean;
  secure: boolean;
  onSubmit: (input: { phone: string; card?: CardValues; widget?: WidgetToken; email?: string }) => void;
}) {
  const { t } = useTranslation();
  const { config, locale } = useAppConfig();
  // Виджет ПСП (ТЗ §5–6): используется, когда CARD_WIDGET не `embedded`.
  const widget = config.cardWidget;
  const [widgetFailed, setWidgetFailed] = useState(false);
  const [widgetPhone, setWidgetPhone] = useState("");
  const [widgetPhoneError, setWidgetPhoneError] = useState<string | null>(null);
  const [widgetUnavailable, setWidgetUnavailable] = useState(false);
  const useWidget = widget.provider !== "embedded" && Boolean(widget.publicKey) && !widgetFailed;
  const schemas = useMemo(
    () => ({
      phone: createPhoneSchema(t),
      paypal: createPaypalSchema(t),
    }),
    [t],
  );

  const phoneForm = useForm<{ phone: string }>({
    resolver: zodResolver(schemas.phone),
    defaultValues: { phone: "" },
    mode: "onBlur",
  });

  const paypalForm = useForm<{ email: string }>({
    resolver: zodResolver(schemas.paypal),
    defaultValues: { email: "" },
    mode: "onBlur",
  });

  const phoneField = phoneForm.register("phone");

  const submit = async (card?: CardValues) => {
    const phoneValid = await phoneForm.trigger();
    let email: string | undefined;
    if (method === "paypal") {
      const emailValid = await paypalForm.trigger();
      if (!emailValid) return;
      email = paypalForm.getValues("email");
    }
    if (!phoneValid) return;
    onSubmit({ phone: phoneForm.getValues("phone"), card, email });
  };

  const brandLabels: Record<string, string> = {
    mir: t("payment.brands.mir"),
    visa: t("payment.brands.visa"),
    mastercard: t("payment.brands.mastercard"),
    amex: t("payment.brands.amex"),
    unionpay: t("payment.brands.unionpay"),
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => onMethodChange("card")}
          aria-pressed={method === "card"}
          className={cn(
            "flex flex-col items-start gap-1 rounded-2xl border p-4 text-left transition",
            method === "card"
              ? "border-brand-500 bg-brand-500/10"
              : "border-white/15 bg-white/[0.03] hover:border-white/35",
          )}
        >
          <CreditCard className="size-5 text-brand-400" aria-hidden />
          <span className="text-sm font-semibold text-white">{t("payment.methodCard")}</span>
          <span className="text-xs text-white/55">
            {brands
              .slice(0, 3)
              .map((brand) => brandLabels[brand] ?? brand)
              .join(" · ")}
          </span>
        </button>

        <button
          type="button"
          onClick={() => onMethodChange("paypal")}
          aria-pressed={method === "paypal"}
          className={cn(
            "flex flex-col items-start gap-1 rounded-2xl border p-4 text-left transition",
            method === "paypal"
              ? "border-brand-500 bg-brand-500/10"
              : "border-white/15 bg-white/[0.03] hover:border-white/35",
          )}
        >
          <Mail className="size-5 text-brand-400" aria-hidden />
          <span className="text-sm font-semibold text-white">{t("payment.methodPaypal")}</span>
          <span className="text-xs text-white/55">PayPal</span>
        </button>
      </div>

      {method === "card" && useWidget ? (
        <>
          {widgetPhoneError ? (
            <p role="alert" className="mb-3 text-sm text-danger">
              {widgetPhoneError}
            </p>
          ) : null}
          <CardWidgetForm
            provider={widget.provider as "yookassa" | "stripe"}
            publicKey={widget.publicKey ?? ""}
            phone={widgetPhone}
            onPhoneChange={setWidgetPhone}
            loading={loading}
            amountLabel={amountLabel}
            onFallback={(reason) => {
              // SDK blocked or tokenization failed: the encrypted embedded form
              // takes over so the purchase can still complete.
              setWidgetFailed(true);
              if (reason === "script_unavailable") setWidgetUnavailable(true);
            }}
            onSubmit={(token) => {
              if (!isValidPhone(widgetPhone)) {
                setWidgetPhoneError(t("payment.phoneInvalid"));
                return;
              }
              onSubmit({ phone: widgetPhone, widget: token });
            }}
          />
        </>
      ) : method === "card" ? (
        <>
          {widgetUnavailable ? (
            <p className="mb-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs text-white/60">
              {t("payment.widgetUnavailable")}
            </p>
          ) : null}
          <CardForm
            loading={loading}
            amountLabel={amountLabel}
            onSubmit={(values) => void submit(values)}
            leading={
              <Input
                {...phoneField}
                onChange={(event) => {
                  event.target.value = formatPhoneInput(event.target.value);
                  void phoneField.onChange(event);
                }}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                label={t("payment.phone")}
                placeholder={config.currencies[locale] === "RUB" ? "+7 916 123-45-67" : "+1 202 555 0123"}
                error={phoneForm.formState.errors.phone?.message}
                hint={t("payment.phoneHint", { count: config.smsCodeLength })}
                leftAddon={<Smartphone className="size-4" aria-hidden />}
              />
            }
          />
        </>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          noValidate
        >
          <Input
            {...phoneField}
            onChange={(event) => {
              event.target.value = formatPhoneInput(event.target.value);
              void phoneField.onChange(event);
            }}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            label={t("payment.phone")}
            placeholder={config.currencies[locale] === "RUB" ? "+7 916 123-45-67" : "+1 202 555 0123"}
            error={phoneForm.formState.errors.phone?.message}
            hint={t("payment.phoneHint", { count: config.smsCodeLength })}
            leftAddon={<Smartphone className="size-4" aria-hidden />}
          />
          <Input
            {...paypalForm.register("email")}
            type="email"
            label={t("payment.paypalEmail")}
            placeholder="you@example.com"
            autoComplete="email"
            error={paypalForm.formState.errors.email?.message}
            leftAddon={<Mail className="size-4" aria-hidden />}
          />
          <Button
            type="submit"
            size="lg"
            fullWidth
            loading={loading}
            leftIcon={<Lock className="size-4" aria-hidden />}
          >
            {t("payment.submit")} · {amountLabel}
          </Button>
        </form>
      )}

      {!secure ? (
        <Alert tone="warning" className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("payment.securityWarning")}
        </Alert>
      ) : null}
    </div>
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  yookassa: "ЮKassa",
  stripe: "Stripe",
  paypal: "PayPal",
  mock: "Demo",
};

/**
 * Off-site provider step: 3-D Secure redirect or PayPal approval.
 * The booking is confirmed by the provider webhook in the background —
 * the page polls it, and the button below lets the user check manually.
 */
function ActionStep({
  provider,
  actionUrl,
  amountLabel,
  onCheck,
  onBack,
}: {
  provider: string;
  actionUrl: string | null;
  amountLabel: string;
  onCheck: () => Promise<void>;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const label = PROVIDER_LABELS[provider] ?? provider;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-brand-500/15">
        <ShieldCheck className="size-6 text-brand-400" aria-hidden />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-white">
        {actionUrl ? t("payment.actionTitle") : t("payment.processingTitle")}
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-white/60">
        {actionUrl
          ? t("payment.actionSubtitle", { provider: label, amount: amountLabel })
          : t("payment.processingSubtitle", { provider: label, amount: amountLabel })}
      </p>

      {actionUrl ? (
        <Button
          type="button"
          size="lg"
          fullWidth
          className="mt-6"
          rightIcon={<ExternalLink className="size-4" aria-hidden />}
          onClick={() => window.open(actionUrl, "_blank", "noopener,noreferrer")}
        >
          {t("payment.openProvider", { provider: label })}
        </Button>
      ) : null}

      <Button
        type="button"
        variant="secondary"
        size="lg"
        fullWidth
        className="mt-3"
        loading={checking}
        leftIcon={<RefreshCw className="size-4" aria-hidden />}
        onClick={() => {
          setChecking(true);
          void onCheck().finally(() => setChecking(false));
        }}
      >
        {t("payment.checkStatus")}
      </Button>

      <button
        type="button"
        onClick={onBack}
        className="mt-4 text-xs text-white/55 transition hover:text-white"
      >
        {t("payment.differentCard")}
      </button>

      <p className="mt-4 text-center text-[11px] text-white/50">{t("payment.actionNote")}</p>
    </div>
  );
}

function CodeStep({
  amountLabel,
  phoneMasked,
  attemptsLeft,
  expiresAt,
  devCode,
  verifying,
  resendRemainingMs,
  onResend,
  resending,
  onSubmit,
  onBack,
}: {
  amountLabel: string;
  phoneMasked: string | null;
  attemptsLeft: number;
  expiresAt: string;
  devCode: string | null;
  verifying: boolean;
  resendRemainingMs: number;
  onResend: () => void;
  resending: boolean;
  onSubmit: (code: string) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { config } = useAppConfig();
  const schemas = useMemo(
    () => ({ code: createCodeSchema(t, config.smsCodeLength) }),
    [t, config.smsCodeLength],
  );

  const { setValue, handleSubmit, watch, formState } = useForm<{ code: string }>({
    resolver: zodResolver(schemas.code),
    defaultValues: { code: "" },
  });
  const code = watch("code");
  const remaining = useCountdown(expiresAt);

  return (
    <form
      className="rounded-2xl border border-white/10 bg-white/[0.03] p-6"
      onSubmit={(event) => void handleSubmit((values) => onSubmit(values.code))(event)}
      noValidate
    >
      <div className="flex items-center gap-2 text-brand-400">
        <MessageSquare className="size-5" aria-hidden />
        <h2 className="text-lg font-semibold text-white">{t("payment.codeTitle")}</h2>
      </div>
      <p className="mt-2 text-sm text-white/60">
        {t("payment.codeSubtitle", {
          count: config.smsCodeLength,
          phone: phoneMasked ?? "",
          amount: amountLabel,
        })}
      </p>

      <div className="mt-6">
        <OtpInput
          value={code}
          onChange={(value) =>
            setValue("code", value, { shouldValidate: value.length === config.smsCodeLength })
          }
          length={config.smsCodeLength}
          disabled={verifying}
          autoFocus
          invalid={Boolean(formState.errors.code)}
        />
        {formState.errors.code?.message ? (
          <p className="mt-2 text-center text-xs text-danger">{formState.errors.code.message}</p>
        ) : null}
      </div>

      {devCode ? (
        <p className="mt-5 rounded-xl bg-warning/10 px-4 py-2.5 text-center text-xs text-amber-200">
          {t("payment.demoCode")} <strong className="font-mono text-sm">{devCode}</strong>
        </p>
      ) : null}

      <Button
        type="submit"
        size="lg"
        fullWidth
        className="mt-6"
        loading={verifying}
        disabled={code.length < config.smsCodeLength}
      >
        {t("payment.verifying")}
      </Button>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-white/50">
        <button
          type="button"
          onClick={onResend}
          disabled={resendRemainingMs > 0 || resending}
          className="font-medium text-brand-400 transition hover:underline disabled:text-white/30 disabled:no-underline"
        >
          {resendRemainingMs > 0
            ? t("payment.resendIn", { time: formatCountdown(resendRemainingMs) })
            : t("payment.resend")}
        </button>
        <span>
          {remaining > 0
            ? `${t("payment.attemptsLeft", { count: attemptsLeft })} · ${formatCountdown(remaining)}`
            : t("payment.attemptsLeft", { count: attemptsLeft })}
        </span>
      </div>

      <button
        type="button"
        onClick={onBack}
        className="mt-4 text-xs text-white/55 transition hover:text-white"
      >
        {t("payment.differentCard")}
      </button>

      <p className="mt-4 text-center text-[11px] text-white/50">{t("payment.codeExpires")}</p>
    </form>
  );
}
