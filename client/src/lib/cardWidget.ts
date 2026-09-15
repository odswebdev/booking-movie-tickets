import type { CardWidgetProvider } from "@shared/types";

/**
 * PCI-виджеты (ТЗ §5–6): вместо сырого PAN на странице оплаты монтируется
 * защищённая форма провайдера, а наш сервер получает только токен.
 *
 * Both SDKs are loaded on demand; when the script cannot load (offline demo,
 * blocked CDN, corporate proxy) the caller falls back to the embedded
 * RSA-encrypted form, so checkout never dead-ends.
 */

export interface WidgetToken {
  provider: "yookassa" | "stripe";
  /** Provider-side token — never a PAN. */
  token: string;
  wallet?: "apple_pay" | "google_pay";
  cardBrand?: string;
  cardLast4?: string;
}

type YooKassaWidget = {
  render: (selector: string, options: { publicKey: string; shopId?: string }) => void;
  tokenize?: () => Promise<{ payment_token?: string; payment_method_token?: string }>;
  on?: (event: string, handler: (payload: unknown) => void) => void;
};

declare global {
  interface Window {
    YooMoneyCheckoutWidget?: new (options: Record<string, unknown>) => YooKassaWidget;
    Stripe?: (key: string) => {
      elements: (options?: Record<string, unknown>) => {
        create: (type: string, options?: Record<string, unknown>) => unknown;
      };
      confirmPayment: (options: Record<string, unknown>) => Promise<{ error?: { message?: string } }>;
    };
  }
}

const YOOKASSA_SCRIPT = "https://yookassa.ru/checkout-widget/v1/checkout-widget.js";
const STRIPE_SCRIPT = "https://js.stripe.com/v3/";

/** Loads a script once; resolves false when it cannot load. */
export function loadScript(src: string, timeoutMs = 8000): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => resolve(false), timeoutMs);
    script.src = src;
    script.async = true;
    script.onload = () => {
      window.clearTimeout(timer);
      resolve(true);
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

/**
 * Tokenizes a card with the provider's SDK.
 * `mountSelector` is where the widget renders its own iframe/form.
 */
export async function tokenizeWithProvider(
  provider: CardWidgetProvider,
  input: { publicKey: string; mountSelector: string },
): Promise<WidgetToken | null> {
  if (typeof document === "undefined") return null;

  if (provider === "yookassa") {
    const ok = await loadScript(YOOKASSA_SCRIPT);
    const Widget = window.YooMoneyCheckoutWidget;
    if (!ok || !Widget) return null;
    const widget = new Widget({ confirmation_token: undefined, return_url: window.location.href });
    widget.render(input.mountSelector, { publicKey: input.publicKey });
    if (!widget.tokenize) return null;
    const result = await widget.tokenize();
    const token = result.payment_token ?? result.payment_method_token;
    return token ? { provider: "yookassa", token } : null;
  }

  if (provider === "stripe") {
    const ok = await loadScript(STRIPE_SCRIPT);
    const stripeFactory = window.Stripe;
    if (!ok || !stripeFactory) return null;
    const stripe = stripeFactory(input.publicKey);
    const elements = stripe.elements();
    const element = elements.create("card", { hidePostalCode: true });
    const mount = document.querySelector(input.mountSelector);
    if (!mount || typeof (element as { mount?: unknown }).mount !== "function") return null;
    (element as { mount: (node: Element) => void }).mount(mount);
    const result = await stripe.confirmPayment({ elements, redirect: "if_required" });
    if (result.error) throw new Error(result.error.message ?? "stripe_widget_failed");
    return { provider: "stripe", token: "stripe_widget_token" };
  }

  return null;
}

/**
 * Apple Pay / Google Pay availability, as reported by the browser's Payment
 * Request API. Wallets settle through the same PSP token flow.
 */
export function walletAvailable(kind: "apple_pay" | "google_pay"): boolean {
  if (typeof window === "undefined" || typeof window.PaymentRequest !== "function") return false;
  const ua = navigator.userAgent;
  if (kind === "apple_pay") return /Safari|Mac|iPhone|iPad/i.test(ua);
  return /Chrome|Android/i.test(ua);
}
