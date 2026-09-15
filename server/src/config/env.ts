import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const booleanish = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no"])])
  .transform((value) => value === true || value === "true" || value === "1" || value === "yes");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().min(1).default("0.0.0.0"),
  /** Comma separated allow-list. `*` disables the allow-list (development only). */
  CORS_ORIGIN: z.string().default("*"),
  JWT_SECRET: z.string().min(1).optional(),
  /** Accepts anything `ms` understands: 30s, 15m, 1h, 7d. */
  JWT_ACCESS_TTL: z
    .string()
    .regex(/^\d+(?:\.\d+)?(?:ms|s|m|h|d|w)?$/, "JWT_ACCESS_TTL must look like 30s, 15m, 1h or 7d")
    .default("15m"),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /**
   * How long an already rotated refresh token is still accepted. Two tabs
   * refreshing at the same time replay the old token; treating that as theft
   * used to log the user out everywhere with no way back.
   */
  REFRESH_REUSE_GRACE_MS: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
  DATA_DIR: z.string().default(path.join(serverRoot, "data")),
  /**
   * PostgreSQL connection string. Unset = JSON-file mode (zero infrastructure).
   * Set = Prisma/PostgreSQL mode with transactions and row-level locking.
   * Example: postgresql://cinetickets:cinetickets@localhost:5432/cinetickets
   */
  DATABASE_URL: z.string().default(""),
  /**
   * Redis connection string. Unset/unreachable = in-memory seat holds and
   * seat events (single instance). Set = Redis holds (Lua, TTL) + pub/sub.
   * Example: redis://localhost:6379
   */
  REDIS_URL: z.string().default(""),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: booleanish.default(false),
  /** Serve `client/dist` (if present) so the API can host the SPA in one container. */
  SERVE_CLIENT: booleanish.default(false),
  /** Rate limiting window/limits, kept configurable for load tests. */
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  PAYMENT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(40),

  /** Catalog provider. Without a key the bundled catalog is used. */
  TMDB_API_KEY: z.string().optional(),
  TMDB_LANGUAGE: z.string().default("en-US"),
  TMDB_REGION: z.string().default("US"),
  TMDB_IMAGE_BASE: z.string().default("https://image.tmdb.org/t/p"),
  TMDB_CACHE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(6 * 60 * 60 * 1000),
  TMDB_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  /** SMS provider for confirmation codes. Unset = `generic` when SMS_PROVIDER_URL is set, else `mock`. */
  SMS_PROVIDER: z.enum(["mock", "generic", "smsru", "smsc", "twilio"]).optional(),
  /** Max confirmation SMS per phone number per hour (abuse cap, ТЗ: 5). */
  SMS_MAX_PER_HOUR: z.coerce.number().int().positive().default(5),
  /** Generic HTTP gateway: POST { to, text, from }, Bearer token when set. */
  SMS_PROVIDER_URL: z.string().default(""),
  SMS_PROVIDER_TOKEN: z.string().optional(),
  SMS_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  SMS_FROM: z.string().default("CineTickets"),
  /** sms.ru — API id from https://sms.ru/api. */
  SMSRU_API_ID: z.string().optional(),
  /** SMSC.ru — login + password (an API key works as the password). */
  SMSC_LOGIN: z.string().optional(),
  SMSC_PASSWORD: z.string().optional(),
  /** Twilio — account SID, auth token and the sending number. */
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),

  /**
   * Email provider for tickets/receipts. Unset = `sendgrid` when the API key
   * is set, `smtp` when SMTP_HOST is set, otherwise `mock` (logged, refused
   * in production like the SMS mock).
   */
  EMAIL_PROVIDER: z.enum(["mock", "smtp", "sendgrid"]).optional(),
  EMAIL_FROM: z.string().default("CineTickets <no-reply@cinetickets.example>"),
  /** SMTP relay (nodemailer). */
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanish.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** SendGrid Web API key (https://sendgrid.com). */
  SENDGRID_API_KEY: z.string().optional(),

  /**
   * IP-geolocation provider. Unset = `maxmind` when GEO_MMDB_PATH is set,
   * else `mock`. `ipapi` (ipapi.co) and `sypex` (api.sypexgeo.net) need no keys.
   */
  GEO_PROVIDER: z.enum(["mock", "ipapi", "sypex", "maxmind"]).optional(),
  /** Local GeoLite2-City.mmdb path (https://dev.maxmind.com/geoip/geolite2-free-geolocation-data). */
  GEO_MMDB_PATH: z.string().default(""),
  GEO_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),

  /**
   * Background-job driver. `auto` = inline in tests, BullMQ when REDIS_URL
   * is set, otherwise inline (zero infrastructure, jobs run in-process).
   */
  QUEUES_DRIVER: z.enum(["auto", "inline", "bullmq"]).default("auto"),

  /** FX overrides, e.g. "RUB:92.5". */
  FX_RATES: z.string().optional(),

  /** How many days ahead the catalog publishes showtimes (ТЗ: 14-day calendar). */
  CATALOG_WINDOW_DAYS: z.coerce.number().int().min(1).max(30).default(14),

  /**
   * Loyalty: share of every settled order credited back as bonus points, and
   * the one-off credits for inviting a friend / joining through an invite.
   */
  BONUS_PERCENT: z.coerce.number().min(0).max(50).default(5),
  REFERRAL_WELCOME_BONUS_CENTS: z.coerce.number().int().min(0).default(300),
  REFERRAL_INVITER_BONUS_CENTS: z.coerce.number().int().min(0).default(500),

  /** Passwordless sign-in link lifetime (email magic link). */
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().min(1).max(120).default(15),

  /** How long guest checkout tokens stay valid (ticket access without an account). */
  GUEST_TOKEN_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(72),

  /**
   * Observability (ТЗ §1.7). `METRICS_ENABLED=false` removes /api/metrics;
   * `METRICS_TOKEN` puts a bearer check in front of it (metrics leak traffic
   * patterns, so production deployments should set one).
   */
  METRICS_ENABLED: booleanish.default(true),
  METRICS_TOKEN: z.string().optional(),
  ALERTS_ENABLED: booleanish.default(true),
  ALERT_EVAL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
  /** Optional Slack/Teams/PagerDuty bridge; alerts are logged either way. */
  ALERT_WEBHOOK_URL: z.string().default(""),
  ALERT_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  ALERT_PAYMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.25),
  ALERT_HTTP_ERROR_RATE: z.coerce.number().min(0).max(1).default(0.05),
  ALERT_AUTH_401_PER_MINUTE: z.coerce.number().positive().default(30),
  ALERT_LATENCY_P95_MS: z.coerce.number().positive().default(1500),
  ALERT_SEAT_CONFLICTS_PER_MINUTE: z.coerce.number().positive().default(30),
  ALERT_SMS_QUOTA_HITS: z.coerce.number().positive().default(10),
  ALERT_NOTIFICATION_FAILURES: z.coerce.number().positive().default(5),
  ALERT_QUEUE_FAILURES: z.coerce.number().positive().default(5),
  ALERT_MIN_HTTP_SAMPLES: z.coerce.number().int().positive().default(20),
  ALERT_MIN_PAYMENT_SAMPLES: z.coerce.number().int().positive().default(5),

  /**
   * Analytics (ТЗ §10): GA4 + Yandex.Metrica through Google Tag Manager.
   * The ids are handed to the client via GET /api/config — no rebuild needed,
   * and a deployment without ids simply does not load any tag.
   */
  GTM_ID: z.string().default(""),
  GA4_ID: z.string().default(""),
  YM_ID: z.string().default(""),

  /**
   * PSP card widgets (ТЗ §5–6: PCI-safe checkout instead of a raw PAN field).
   * `auto` mounts the provider's own widget when a public key / publishable
   * key is configured, otherwise the encrypted embedded form is used.
   */
  CARD_WIDGET: z.enum(["auto", "embedded", "yookassa", "stripe"]).default("auto"),

  /** Comma separated promo codes "CODE:percent", e.g. "WELCOME10:10,CINEMA20:20". */
  PROMO_CODES: z.string().default("WELCOME10:10,CINEMA20:20,STUDENT15:15"),

  /** Card PSP: mock (demo) | yookassa (МИР/СБП) | stripe (Visa/MC). */
  PAYMENTS_PROVIDER: z.enum(["mock", "yookassa", "stripe"]).default("mock"),
  /** Public base URL of the web client (PSP return/approval redirects). */
  APP_PUBLIC_URL: z.string().default("http://localhost:5173"),

  /** YooKassa (https://yookassa.ru/developers) — shop id + secret key. */
  YOOKASSA_SHOP_ID: z.string().optional(),
  YOOKASSA_SECRET_KEY: z.string().optional(),
  YOOKASSA_API_URL: z.string().default("https://api.yookassa.ru/v3"),

  /** Stripe (https://docs.stripe.com) — secret key + webhook signing secret. */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_API_URL: z.string().default("https://api.stripe.com"),

  /** Public widget key (YooKassa: shop id + public key; Stripe: publishable key). */
  YOOKASSA_PUBLIC_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),

  /** PayPal Checkout (sandbox by default) — REST app credentials + webhook id. */
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_SECRET: z.string().optional(),
  PAYPAL_API_URL: z.string().default("https://api-m.sandbox.paypal.com"),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
  throw new Error(`Invalid server environment configuration:\n${issues.join("\n")}`);
}

const values = parsed.data;

/**
 * A signing secret is mandatory outside development: without it every token
 * would be forgeable, which is a critical security hole in production.
 */
if (values.NODE_ENV === "production" && !values.JWT_SECRET) {
  throw new Error("JWT_SECRET must be set when NODE_ENV=production");
}

/** Name of the httpOnly cookie that mirrors the access token. */
export const SESSION_COOKIE = "ct_session";

/**
 * Location of the built client for SERVE_CLIENT mode. Layouts differ:
 * dev (tsx) → `server/` + `../client/dist`; compiled → `server/dist/server/`
 * with the bundle either beside it (Docker copies `dist/client/dist`) or at
 * the repository root (`../../../client/dist`). First existing wins.
 */
function resolveClientDist(root: string): string {
  const primary = path.resolve(root, "../client/dist");
  const candidates = [
    primary,
    path.resolve(root, "../../client/dist"),
    path.resolve(root, "../../../client/dist"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return primary;
}

export const env = {
  ...values,
  hasTmdb: Boolean(values.TMDB_API_KEY),
  /** Falls back to an ephemeral secret in development/test only. */
  jwtSecret: values.JWT_SECRET ?? "dev-only-insecure-secret-change-me",
  isProduction: values.NODE_ENV === "production",
  isTest: values.NODE_ENV === "test",
  corsOrigins: values.CORS_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  serverRoot,
  clientDist: resolveClientDist(serverRoot),
};

export type Env = typeof env;
