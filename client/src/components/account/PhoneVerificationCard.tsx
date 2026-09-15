import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BadgeCheck, Smartphone } from "lucide-react";
import { authApi } from "@/api/endpoints";
import { useToast } from "@/context/ToastContext";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatPhoneInput } from "@/lib/phone";
import { track } from "@/lib/analytics";
import { translateApiError } from "@/lib/errors";

/**
 * SMS-верификация номера (ТЗ §2/§5): запрос кода и его подтверждение.
 * The verified number is what the payment step uses by default, and it is
 * stored on the user row (`phone` + `phoneVerifiedAt`).
 */
export function PhoneVerificationCard() {
  const { t } = useTranslation();
  const { user, refresh } = useAuth();
  const { toast } = useToast();
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"idle" | "code">(user?.phoneVerifiedAt ? "idle" : "idle");
  const [busy, setBusy] = useState(false);

  const verified = Boolean(user?.phoneVerifiedAt);

  const sendCode = async () => {
    setBusy(true);
    try {
      const result = await authApi.phoneVerifyRequest(phone);
      setStage("code");
      if (result.devCode) setCode(result.devCode);
      toast({ title: t("auth.phoneSent", { phone: result.phoneMasked }), variant: "success" });
    } catch (error) {
      toast({ title: t("auth.phoneFailed"), description: translateApiError(error, t), variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await authApi.phoneVerifyConfirm({ code, phone });
      await refresh();
      track("phone_verified", {});
      toast({ title: t("auth.phoneVerifiedToast"), variant: "success" });
      setStage("idle");
      setCode("");
    } catch (error) {
      toast({ title: t("auth.phoneFailed"), description: translateApiError(error, t), variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="account-phone-heading"
      className="mt-6 rounded-2xl border border-white/10 bg-ink-800/50 p-6"
    >
      <h2 id="account-phone-heading" className="flex items-center gap-2 text-lg font-semibold text-white">
        <Smartphone className="size-4 text-brand-400" aria-hidden />
        {t("auth.phoneTitle")}
        {verified ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-brand-300">
            <BadgeCheck className="size-4" aria-hidden />
            {t("auth.phoneVerified")}
          </span>
        ) : (
          <span className="text-xs font-medium text-white/55">{t("auth.phoneNotVerified")}</span>
        )}
      </h2>

      <div className="mt-4 space-y-3">
        <Input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          label={t("auth.phoneTitle")}
          value={phone}
          onChange={(event) => setPhone(formatPhoneInput(event.target.value))}
          leftAddon={<Smartphone className="size-4" aria-hidden />}
        />

        {stage === "code" ? (
          <>
            <Input
              label={t("auth.phoneCodeLabel")}
              value={code}
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            <Button size="lg" loading={busy} disabled={code.length !== 6} onClick={() => void confirm()}>
              {t("auth.phoneConfirm")}
            </Button>
          </>
        ) : (
          <Button
            size="lg"
            variant={verified ? "secondary" : "primary"}
            loading={busy}
            disabled={phone.trim().length < 6}
            onClick={() => void sendCode()}
          >
            {t("auth.phoneSendCode")}
          </Button>
        )}
      </div>
    </section>
  );
}
