import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound, Mail, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { authApi } from "@/api/endpoints";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/context/ToastContext";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useSeo } from "@/hooks/useSeo";
import { createAuthSchemas, type LoginFormValues } from "@/lib/validation";
import { ApiRequestError, isApiError } from "@/api/http";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Feedback";
import { translateApiError } from "@/lib/errors";
import { track } from "@/lib/analytics";
import { useAppConfig } from "@/i18n/AppConfigProvider";

interface LocationState {
  from?: string;
}

export default function LoginPage() {
  const { t } = useTranslation();
  const { login, magicLink, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { locale } = useAppConfig();
  useDocumentTitle(t("auth.loginTitle"));
  useSeo({ title: `${t("auth.loginTitle")} — CineTickets`, locale, path: "/login", noindex: true });

  const schemas = useMemo(() => createAuthSchemas(t), [t]);
  const locationState = (location.state as LocationState | null) ?? null;
  const from = locationState?.from ?? "/";

  // Magic link (ТЗ §6): the email link lands on /login?magic=<token>.
  const magicToken = new URLSearchParams(location.search).get("magic");
  const consumed = useRef(false);
  const [magicError, setMagicError] = useState<string | null>(null);
  const [magicPending, setMagicPending] = useState(false);
  const [linkMode, setLinkMode] = useState(false);
  const [linkSent, setLinkSent] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(schemas.login),
    defaultValues: { email: "", password: "" },
  });

  useEffect(() => {
    if (status === "authenticated" && !magicToken) navigate(from, { replace: true });
  }, [status, from, navigate, magicToken]);

  // A link is single-use, so it is exchanged exactly once per page load.
  useEffect(() => {
    if (!magicToken || consumed.current) return;
    consumed.current = true;
    setMagicPending(true);
    void (async () => {
      try {
        const user = await magicLink(magicToken);
        track("magic_link_requested", { source: "email_link", result: "signed_in" });
        toast({ title: t("auth.welcomeBack", { name: user.name }), variant: "success" });
        navigate(from, { replace: true });
      } catch (error) {
        setMagicError(
          error instanceof ApiRequestError ? translateApiError(error, t) : t("auth.magicLinkInvalid"),
        );
      } finally {
        setMagicPending(false);
      }
    })();
  }, [magicToken, magicLink, from, navigate, t, toast]);

  if (status === "authenticated" && !magicToken) return <Navigate to={from} replace />;

  const onSubmit = async (values: LoginFormValues) => {
    try {
      const user = await login(values);
      track("login", { method: "password" });
      toast({ title: t("auth.welcomeBack", { name: user.name }), variant: "success" });
      navigate(from, { replace: true });
    } catch (error) {
      const message =
        isApiError(error, "unauthorized") || isApiError(error, "validation_error")
          ? t("errors.unauthorized")
          : error instanceof ApiRequestError
            ? translateApiError(error, t)
            : t("errors.internal");
      setError("root", { message });
    }
  };

  const requestLink = async () => {
    const email = getValues("email");
    if (!email) {
      setError("email", { message: t("errors.required") });
      return;
    }
    try {
      const result = await authApi.magicLinkRequest(email);
      setLinkSent(email);
      track("magic_link_requested", { source: "login_page" });
      if (result.devToken) {
        setDevLink(`${window.location.origin}${import.meta.env.BASE_URL}login?magic=${result.devToken}`);
      }
    } catch (error) {
      setError("root", { message: translateApiError(error, t) });
    }
  };

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 sm:px-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
        <h1 className="text-2xl font-bold text-white">{t("auth.loginTitle")}</h1>
        <p className="mt-1.5 text-sm text-white/55">{t("auth.loginSubtitle")}</p>

        {magicPending ? (
          <Alert tone="info" className="mt-5">
            {t("auth.magicLinkVerifying")}
          </Alert>
        ) : null}

        {magicError ? (
          <Alert tone="danger" className="mt-5">
            {magicError}
          </Alert>
        ) : null}

        {errors.root?.message ? (
          <Alert tone="danger" className="mt-5">
            {errors.root.message}
          </Alert>
        ) : null}

        {linkSent ? (
          <Alert tone="success" className="mt-5">
            <p className="font-medium">{t("auth.magicLinkSent")}</p>
            <p className="mt-1 text-sm">{t("auth.magicLinkSentDescription", { email: linkSent })}</p>
            {devLink ? (
              <a href={devLink} className="mt-2 block break-all text-xs text-brand-300 underline">
                {devLink}
              </a>
            ) : null}
          </Alert>
        ) : null}

        <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(onSubmit)(event)} noValidate>
          <Input
            {...register("email")}
            type="email"
            label={t("auth.email")}
            autoComplete="email"
            placeholder="you@example.com"
            error={errors.email?.message}
            leftAddon={<Mail className="size-4" aria-hidden />}
          />

          {!linkMode ? (
            <Input
              {...register("password")}
              type="password"
              label={t("auth.password")}
              autoComplete="current-password"
              placeholder="••••••••"
              error={errors.password?.message}
              leftAddon={<KeyRound className="size-4" aria-hidden />}
            />
          ) : null}

          {linkMode ? (
            <Button
              type="button"
              size="lg"
              fullWidth
              leftIcon={<Send className="size-4" aria-hidden />}
              onClick={() => void requestLink()}
            >
              {t("auth.magicLink")}
            </Button>
          ) : (
            <Button type="submit" size="lg" fullWidth loading={isSubmitting}>
              {t("auth.loginSubmit")}
            </Button>
          )}
        </form>

        <div className="mt-4 text-center">
          <button
            type="button"
            className="text-sm text-brand-300 hover:underline"
            onClick={() => {
              setLinkMode((value) => !value);
              setLinkSent(null);
              setDevLink(null);
            }}
          >
            {linkMode ? t("auth.orPassword") : t("auth.magicLink")}
          </button>
          {!linkMode ? <p className="mt-1 text-xs text-white/55">{t("auth.magicLinkHint")}</p> : null}
        </div>

        <p className="mt-6 text-center text-sm text-white/55">
          {t("auth.noAccount")}{" "}
          <Link to="/register" state={locationState} className="font-medium text-brand-400 hover:underline">
            {t("auth.createOne")}
          </Link>
        </p>
      </div>
    </div>
  );
}
