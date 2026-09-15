import type { AppConfig } from "@shared/types";

/**
 * Analytics (ТЗ §10): GTM контейнер + GA4 + Яндекс.Метрика и события
 * `view_movie … payment_failed`, плюс захват UTM-меток, которые уезжают на
 * сервер заголовком `X-Utm` и попадают в `AuditLog.meta`.
 *
 * Everything degrades safely: without ids nothing is loaded, without
 * `window.dataLayer` events are dropped. No id is ever hard-coded here.
 */

export const UTM_STORAGE_KEY = "cinetickets:utm";
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

export type AnalyticsEvent =
  | "page_view"
  | "view_movie"
  | "view_showtime"
  | "view_seat_map"
  | "select_seat"
  | "begin_checkout"
  | "add_payment_info"
  | "sms_code_sent"
  | "sms_code_verified"
  | "purchase"
  | "payment_failed"
  | "refund"
  | "sign_up"
  | "login"
  | "guest_checkout"
  | "magic_link_requested"
  | "phone_verified"
  | "trailer_open"
  | "review_submitted"
  | "search"
  | "promo_applied";

type Payload = Record<string, unknown>;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    ym?: (id: number, action: string, ...rest: unknown[]) => void;
  }
}

function dataLayer(): unknown[] | null {
  if (typeof window === "undefined") return null;
  if (!Array.isArray(window.dataLayer)) window.dataLayer = [];
  return window.dataLayer;
}

/** Reads `utm_*` from the landing URL and keeps them for the whole session. */
export function captureUtm(
  search: string = typeof window === "undefined" ? "" : window.location.search,
): void {
  try {
    const params = new URLSearchParams(search);
    const found: Record<string, string> = {};
    for (const key of UTM_KEYS) {
      const value = params.get(key);
      if (value) found[key] = value.slice(0, 64);
    }
    if (Object.keys(found).length > 0) sessionStorage.setItem(UTM_STORAGE_KEY, JSON.stringify(found));
  } catch {
    /* storage blocked — attribution is best-effort */
  }
}

export function readUtm(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(UTM_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** `utm_source=google&utm_medium=cpc` — the header value the API parses. */
export function utmHeaderValue(): string | null {
  const utm = readUtm();
  const entries = Object.entries(utm);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

function injectScript(src: string, attrs: Record<string, string> = {}): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(`script[src="${src}"]`)) return;
  const script = document.createElement("script");
  script.async = true;
  script.src = src;
  for (const [key, value] of Object.entries(attrs)) script.setAttribute(key, value);
  document.head.appendChild(script);
}

/**
 * Boots the tag stack.
 *
 * GTM is the primary container (GA4 and Метрика are configured inside it —
 * the ids below are pushed to the data layer so the container can use them).
 * When a deployment configures GA4/YM without GTM, the tags are loaded
 * directly so analytics still works.
 */
let activeIds: AppConfig["analytics"] = { gtmId: "", ga4Id: "", ymId: "" };

export function initAnalytics(analytics: AppConfig["analytics"]): void {
  const layer = dataLayer();
  if (!layer) return;
  activeIds = analytics;
  layer.push({ event: "analytics_ids", ga4Id: analytics.ga4Id, ymId: analytics.ymId });

  if (analytics.gtmId) {
    layer.push({ "gtm.start": Date.now(), event: "gtm.js" });
    injectScript(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(analytics.gtmId)}`);
  }

  if (!analytics.gtmId && analytics.ga4Id) {
    injectScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(analytics.ga4Id)}`);
    window.gtag?.("js", new Date());
    window.gtag?.("config", analytics.ga4Id, { send_page_view: false });
  }

  if (!analytics.gtmId && analytics.ymId) {
    const id = Number(analytics.ymId);
    if (Number.isFinite(id)) {
      layer.push({ event: "ym_init", ymId: id });
      injectScript("https://mc.yandex.ru/metrika/tag.js");
    }
  }

  captureUtm();
}

/**
 * Pushes one analytics event.
 *
 * The payload goes to the GTM data layer (where the container forwards it to
 * GA4/Metrika) and additionally to `gtag`/`ym` when those are loaded — so the
 * same call site works in every configuration. No PII is ever sent: ids,
 * prices, slugs and hashed-free labels only.
 */
export function track(event: AnalyticsEvent, payload: Payload = {}): void {
  const enriched = { ...payload, ...readUtm() };
  dataLayer()?.push({ event, ...enriched });
  try {
    window.gtag?.("event", event, enriched);
    const ymId = Number(activeIds.ymId);
    if (Number.isFinite(ymId) && ymId > 0 && typeof window.ym === "function") {
      window.ym(ymId, "reachGoal", event, enriched);
    }
  } catch {
    /* analytics must never break the app */
  }
}

/** SPA navigation tracking: one `page_view` per route change. */
export function trackPageView(path: string, title?: string): void {
  track("page_view", { page_path: path, page_title: title });
  try {
    window.gtag?.("event", "page_view", { page_path: path, page_title: title });
  } catch {
    /* ignore */
  }
}

export const ANALYTICS_EVENTS = {
  viewMovie: "view_movie",
  viewShowtime: "view_showtime",
  viewSeatMap: "view_seat_map",
  selectSeat: "select_seat",
  beginCheckout: "begin_checkout",
  addPaymentInfo: "add_payment_info",
  smsCodeSent: "sms_code_sent",
  smsCodeVerified: "sms_code_verified",
  purchase: "purchase",
  paymentFailed: "payment_failed",
  refund: "refund",
  signUp: "sign_up",
  login: "login",
  guestCheckout: "guest_checkout",
  magicLinkRequested: "magic_link_requested",
  phoneVerified: "phone_verified",
  trailerOpen: "trailer_open",
  reviewSubmitted: "review_submitted",
  promoApplied: "promo_applied",
} as const;
