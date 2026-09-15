import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export function Footer() {
  const { t } = useTranslation();
  return (
    <footer className="border-t border-white/5 bg-ink-950/60">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-4 py-6 text-sm text-white/55 sm:flex-row sm:px-6">
        <p>{t("footer.rights", { year: new Date().getFullYear() })}</p>
        <nav className="flex items-center gap-4" aria-label="Footer">
          <Link to="/" className="transition hover:text-white">
            {t("nav.home")}
          </Link>
          <Link to="/my-tickets" className="transition hover:text-white">
            {t("nav.myTickets")}
          </Link>
        </nav>
      </div>
    </footer>
  );
}
