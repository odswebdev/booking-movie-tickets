import { useEffect, useMemo } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Gift, Mail } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useSeo } from "@/hooks/useSeo";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { track } from "@/lib/analytics";
import { createAuthSchemas, type RegisterFormValues } from "@/lib/validation";
import { ApiRequestError } from "@/api/http";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Feedback";
import { translateApiError } from "@/lib/errors";

interface LocationState {
  from?: string;
}

export default function RegisterPage() {
  const { t } = useTranslation();
  const { register: registerUser, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { locale } = useAppConfig();
  useDocumentTitle(t("auth.registerTitle"));
  useSeo({ title: `${t("auth.registerTitle")} — CineTickets`, locale, path: "/register", noindex: true });

  const schemas = useMemo(() => createAuthSchemas(t), [t]);
  const locationState = (location.state as LocationState | null) ?? null;
  const from = locationState?.from ?? "/";

  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(schemas.register),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "", referralCode: "" },
    mode: "onBlur",
  });

  useEffect(() => {
    if (status === "authenticated") navigate(from, { replace: true });
  }, [status, from, navigate]);

  if (status === "authenticated") return <Navigate to={from} replace />;

  const password = watch("password") ?? "";
  const rules = [
    { label: t("auth.passwordRules.length"), met: password.length >= 8 },
    { label: t("auth.passwordRules.upper"), met: /[A-Z]/.test(password) },
    { label: t("auth.passwordRules.lower"), met: /[a-z]/.test(password) },
    { label: t("auth.passwordRules.number"), met: /\d/.test(password) },
  ];

  const onSubmit = async (values: RegisterFormValues) => {
    try {
      const user = await registerUser({ ...values, referralCode: values.referralCode || undefined });
      track("sign_up", { method: "password", referred: Boolean(values.referralCode) });
      toast({
        title: t("auth.welcome", { name: user.name }),
        description: t("auth.accountReady"),
        variant: "success",
      });
      navigate(from, { replace: true });
    } catch (error) {
      const message = error instanceof ApiRequestError ? translateApiError(error, t) : t("errors.internal");
      setError("root", { message });
    }
  };

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 sm:px-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
        <h1 className="text-2xl font-bold text-white">{t("auth.registerTitle")}</h1>
        <p className="mt-1.5 text-sm text-white/55">{t("auth.registerSubtitle")}</p>

        {errors.root?.message ? (
          <Alert tone="danger" className="mt-5">
            {errors.root.message}
          </Alert>
        ) : null}

        <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(onSubmit)(event)} noValidate>
          <Input
            {...register("name")}
            label={t("auth.name")}
            autoComplete="name"
            placeholder={t("auth.name")}
            error={errors.name?.message}
          />
          <Input
            {...register("email")}
            type="email"
            label={t("auth.email")}
            autoComplete="email"
            placeholder="you@example.com"
            error={errors.email?.message}
            leftAddon={<Mail className="size-4" aria-hidden />}
          />
          <Input
            {...register("password")}
            type="password"
            label={t("auth.password")}
            autoComplete="new-password"
            placeholder="••••••••"
            error={errors.password?.message}
            hint={password ? rules.map((rule) => rule.label).join(" · ") : undefined}
          />
          <Input
            {...register("confirmPassword")}
            type="password"
            label={t("auth.confirmPassword")}
            autoComplete="new-password"
            placeholder="••••••••"
            error={errors.confirmPassword?.message}
          />

          <ul className="grid grid-cols-2 gap-1.5 text-[11px]" aria-live="polite">
            {rules.map((rule) => (
              <li key={rule.label} className={rule.met ? "text-brand-400" : "text-white/50"}>
                {rule.met ? "✓" : "•"} {rule.label}
              </li>
            ))}
          </ul>

          <Input
            {...register("referralCode")}
            label={t("auth.referralCode")}
            autoComplete="off"
            placeholder="CINE-XXXX"
            error={errors.referralCode?.message}
            hint={t("auth.referralHint")}
            leftAddon={<Gift className="size-4" aria-hidden />}
          />

          <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
            {t("auth.registerSubmit")}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-white/55">
          {t("auth.hasAccount")}{" "}
          <Link to="/login" state={locationState} className="font-medium text-brand-400 hover:underline">
            {t("auth.loginLink")}
          </Link>
        </p>
      </div>
    </div>
  );
}
