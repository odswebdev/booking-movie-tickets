import { Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useEffect } from "react";
import { Header } from "./Header";
import { Footer } from "./Footer";

/** Shared chrome: ambient background, header, routed content, footer. */
export function AppShell() {
  const { i18n, t } = useTranslation();

  // Keep <html lang> in sync so screen readers use the right voice.
  useEffect(() => {
    document.documentElement.lang = i18n.language === "ru" ? "ru" : "en";
  }, [i18n.language]);

  return (
    <div className="relative min-h-dvh overflow-hidden bg-ink-900">
      <div className="glow-bottom-left" aria-hidden />
      <div className="glow-top-right" aria-hidden />

      <div className="relative z-10 flex min-h-dvh flex-col">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand-500 focus:px-4 focus:py-2 focus:text-ink-950"
        >
          {t("nav.skipToContent")}
        </a>
        <Header />
        <main id="main-content" className="flex-1">
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  );
}
