import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Globe } from "lucide-react";
import { cn } from "@/lib/cn";
import { LOCALE_LABELS, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES } from "@/i18n";
import { useAppConfig } from "@/i18n/AppConfigProvider";
import { switchLocaleUrl } from "@/lib/localeRouting";

/**
 * RU / EN switcher. A real dropdown (not a bare select) so it can show the
 * currency that comes with the language — Russian prices in ₽, English in $.
 */
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { i18n, t } = useTranslation();
  const { currency } = useAppConfig();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const active: (typeof SUPPORTED_LOCALES)[number] = i18n.language === "ru" ? "ru" : "en";

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /**
   * Locale lives in the URL (ТЗ §9b), so switching navigates to the same page
   * under the other prefix. A full document load is intentional: the server
   * renders `<html lang>`, `hreflang` and the JSON-LD block per prefix.
   */
  function select(locale: (typeof SUPPORTED_LOCALES)[number]) {
    setOpen(false);
    if (locale === active) return;
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      /* storage blocked — the URL prefix still carries the locale */
    }
    const target = switchLocaleUrl(
      locale,
      window.location.pathname,
      window.location.search,
      window.location.hash,
    );
    window.location.assign(target);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("nav.languageLabel")}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 text-sm text-white/85 transition",
          "hover:border-white/40 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500",
          compact ? "h-9 px-2.5" : "h-10 px-3",
        )}
      >
        <Globe className="size-4 text-white/60" aria-hidden />
        <span className="font-semibold">{LOCALE_LABELS[active].flag}</span>
        <span className="hidden text-white/55 sm:inline">{currency === "RUB" ? "₽" : "$"}</span>
        <ChevronDown
          className={cn("size-3.5 text-white/50 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label={t("nav.language")}
          className="absolute right-0 z-50 mt-2 w-48 origin-top-right overflow-hidden rounded-xl border border-white/10 bg-ink-800/95 p-1 shadow-2xl backdrop-blur animate-fade-in"
        >
          {SUPPORTED_LOCALES.map((locale) => (
            <li key={locale}>
              <button
                type="button"
                role="option"
                aria-selected={locale === active}
                onClick={() => void select(locale)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition",
                  locale === active
                    ? "bg-brand-500/15 text-white"
                    : "text-white/75 hover:bg-white/5 hover:text-white",
                )}
              >
                <span className="flex items-center gap-2.5">
                  <span className="grid size-7 place-items-center rounded-md bg-white/10 text-[11px] font-bold">
                    {LOCALE_LABELS[locale].flag}
                  </span>
                  {LOCALE_LABELS[locale].native}
                </span>
                <span className="flex items-center gap-2 text-xs text-white/55">
                  {locale === "ru" ? "₽" : "$"}
                  {locale === active ? <Check className="size-4 text-brand-400" aria-hidden /> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
