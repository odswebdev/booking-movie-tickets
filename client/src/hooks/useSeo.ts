import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import type { Locale } from "@shared/types";
import { localePath } from "@/lib/seoLd";

/**
 * Client-side SEO (ТЗ §8): держит `<title>`, description, canonical, hreflang,
 * Open Graph и JSON-LD в синхроне с текущим роутом.
 *
 * Crawlers get the same data from the prerendered shell (server-side); this
 * hook keeps SPA navigation (and link unfurlers that run JS) consistent.
 */
export interface SeoInput {
  title: string;
  description?: string;
  locale: Locale;
  /** Path inside the locale prefix, e.g. `/movies/dune-two`. */
  path: string;
  image?: string | null;
  type?: "website" | "video.movie";
  jsonLd?: Array<Record<string, unknown>>;
  noindex?: boolean;
}

function upsertMeta<T extends Element>(selector: string, create: () => T): T {
  const existing = document.head.querySelector<T>(selector);
  if (existing) return existing;
  const element = create();
  document.head.appendChild(element);
  return element;
}

function setMeta(attr: "name" | "property", key: string, content: string): void {
  const element = upsertMeta(`meta[${attr}="${key}"]`, () => {
    const meta = document.createElement("meta");
    meta.setAttribute(attr, key);
    return meta;
  });
  element.setAttribute("content", content);
}

function setLink(rel: string, href: string, hreflang?: string): void {
  const selector = hreflang
    ? `link[rel="${rel}"][hreflang="${hreflang}"]`
    : `link[rel="${rel}"]:not([hreflang])`;
  const element = upsertMeta(selector, () => {
    const link = document.createElement("link");
    link.setAttribute("rel", rel);
    if (hreflang) link.setAttribute("hreflang", hreflang);
    return link;
  });
  element.setAttribute("href", href);
}

export function useSeo(input: SeoInput): void {
  const location = useLocation();

  useEffect(() => {
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const base = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");
    const canonicalPath = `${base}${localePath(input.locale, input.path)}`;
    const canonical = input.path.startsWith("http") ? input.path : `${origin}${canonicalPath}`;

    document.title = input.title;
    if (input.description) setMeta("name", "description", input.description);

    setLink("canonical", canonical);
    for (const locale of ["en", "ru"] as const) {
      setLink("alternate", `${origin}${base}${localePath(locale, input.path)}`, locale);
    }
    setLink("alternate", `${origin}${base}${localePath("en", input.path)}`, "x-default");

    setMeta("property", "og:title", input.title);
    setMeta("property", "og:type", input.type ?? "website");
    setMeta("property", "og:url", canonical);
    setMeta("property", "og:site_name", "CineTickets");
    if (input.description) setMeta("property", "og:description", input.description);
    if (input.image) setMeta("property", "og:image", input.image);
    setMeta("name", "twitter:card", input.image ? "summary_large_image" : "summary");

    const robots = upsertMeta('meta[name="robots"]', () => {
      const meta = document.createElement("meta");
      meta.setAttribute("name", "robots");
      return meta;
    });
    robots.setAttribute("content", input.noindex ? "noindex, nofollow" : "index, follow");

    const scriptId = "seo-jsonld";
    document.getElementById(scriptId)?.remove();
    if (input.jsonLd && input.jsonLd.length > 0) {
      const script = document.createElement("script");
      script.type = "application/ld+json";
      script.id = scriptId;
      script.textContent = JSON.stringify(input.jsonLd).replace(/</g, "\\u003c");
      document.head.appendChild(script);
    }
  }, [
    input.title,
    input.description,
    input.locale,
    input.path,
    input.image,
    input.type,
    input.noindex,
    input.jsonLd,
    location.pathname,
  ]);
}

/** Document title only — the lighter cousin of `useSeo`. */
export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
