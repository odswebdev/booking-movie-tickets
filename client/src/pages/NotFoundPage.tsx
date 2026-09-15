import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ButtonLink } from "@/components/ui/Button";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function NotFoundPage() {
  const { t } = useTranslation();
  const location = useLocation();
  useDocumentTitle(t("notFound.title"));

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center px-4 py-24 text-center sm:px-6">
      <p className="font-mono text-sm tracking-[0.3em] text-brand-400">404</p>
      <h1 className="mt-3 text-3xl font-bold text-white">{t("notFound.title")}</h1>
      <p className="mt-2 text-sm text-white/55">{t("notFound.subtitle")}</p>
      <p className="mt-1 break-all font-mono text-xs text-white/50">{location.pathname}</p>

      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <ButtonLink to="/">{t("notFound.home")}</ButtonLink>
        <ButtonLink to="/my-tickets" variant="secondary">
          {t("notFound.tickets")}
        </ButtonLink>
      </div>
    </div>
  );
}
