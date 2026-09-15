import { useMemo, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslation } from "react-i18next";
import { CreditCard, Eye, EyeOff, Lock } from "lucide-react";
import { createCardSchema, type CardFormValues } from "@/lib/validation";
import { cardBrand, formatCardNumber, formatExpiry, maskCardNumberGrouped, onlyDigits } from "@/lib/card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export interface CardFormProps {
  onSubmit: (values: CardFormValues) => void | Promise<void>;
  loading?: boolean;
  submitLabel?: string;
  amountLabel?: string;
  /** Extra fields (e.g. the phone number) rendered inside the same form. */
  leading?: ReactNode;
}

/**
 * Card details entry.
 *
 * Formatting (grouping, expiry) happens as the user types and the same rules
 * (Luhn + expiry) are enforced again on the server. The number is masked as
 * soon as the field loses focus and the CVC is never shown in plain text —
 * the payload itself is RSA-OAEP encrypted before it leaves the browser.
 */
export function CardForm({ onSubmit, loading, submitLabel, amountLabel, leading }: CardFormProps) {
  const { t } = useTranslation();
  const schemas = useMemo(() => ({ card: createCardSchema(t) }), [t]);
  const [focused, setFocused] = useState(false);
  const [revealCvc, setRevealCvc] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<CardFormValues>({
    resolver: zodResolver(schemas.card),
    mode: "onBlur",
    defaultValues: { number: "", name: "", expiry: "", cvc: "" },
  });

  const numberField = register("number");
  const expiryField = register("expiry");
  const cvcField = register("cvc");
  const number = watch("number");
  const cvc = watch("cvc");
  const brand = cardBrand(number);
  const label = submitLabel ?? t("payment.submit");

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        void handleSubmit(async (values) => {
          await onSubmit(values);
        })(event);
      }}
      noValidate
    >
      {leading}

      <div className="relative">
        <Input
          {...numberField}
          onChange={(event) => {
            event.target.value = formatCardNumber(event.target.value);
            void numberField.onChange(event);
          }}
          onFocus={() => setFocused(true)}
          onBlur={(event) => {
            setFocused(false);
            void numberField.onBlur(event);
          }}
          label={t("payment.cardNumber")}
          placeholder="4242 4242 4242 4242"
          inputMode="numeric"
          autoComplete="cc-number"
          error={errors.number?.message}
          leftAddon={<CreditCard className="size-4" aria-hidden />}
          rightAddon={
            <span className="text-xs font-semibold uppercase tracking-wide">
              {t(`payment.brands.${brand}`)}
            </span>
          }
        />
        {/* Shoulder-surfing guard: the number is hidden whenever the field is idle. */}
        {!focused && onlyDigits(number).length > 4 ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-[26px] flex h-11 items-center rounded-xl border border-transparent bg-ink-900/95 px-3 text-[15px] tracking-wider text-white/80"
            aria-hidden
          >
            {maskCardNumberGrouped(number)}
          </div>
        ) : null}
      </div>

      <Input
        {...register("name")}
        label={t("payment.cardName")}
        placeholder="Ada Lovelace"
        autoComplete="cc-name"
        error={errors.name?.message}
      />

      <div className="grid grid-cols-2 gap-4">
        <Input
          {...expiryField}
          onChange={(event) => {
            event.target.value = formatExpiry(event.target.value);
            void expiryField.onChange(event);
          }}
          label={t("payment.expiry")}
          placeholder="MM/YY"
          inputMode="numeric"
          autoComplete="cc-exp"
          maxLength={5}
          error={errors.expiry?.message}
        />
        <div className="relative">
          <Input
            {...cvcField}
            onChange={(event) => {
              event.target.value = onlyDigits(event.target.value).slice(0, 4);
              void cvcField.onChange(event);
            }}
            label={t("payment.cvc")}
            placeholder="123"
            inputMode="numeric"
            autoComplete="cc-csc"
            maxLength={4}
            type={revealCvc ? "text" : "password"}
            error={errors.cvc?.message}
          />
          <button
            type="button"
            onClick={() => setRevealCvc((value) => !value)}
            disabled={!cvc}
            aria-label={revealCvc ? t("payment.hideCvc") : t("payment.showCvc")}
            className="absolute right-3 top-[34px] text-white/40 transition hover:text-white disabled:opacity-30"
          >
            {revealCvc ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
          </button>
        </div>
      </div>

      <Button
        type="submit"
        size="lg"
        fullWidth
        loading={loading}
        leftIcon={<Lock className="size-4" aria-hidden />}
      >
        {amountLabel ? `${label} · ${amountLabel}` : label}
      </Button>

      <p className="text-center text-xs text-white/50">{t("payment.secureNote")}</p>
    </form>
  );
}
