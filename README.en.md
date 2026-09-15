# CineTickets — online movie ticket booking

A full-stack cinema ticketing platform: pick a **movie → cinema → date → time → seats**, hold seats with a
countdown, pay by **Mir / Visa / Mastercard / UnionPay card** or **PayPal** with a **6-digit SMS confirmation
code**, then get an e-ticket with a QR code and keep everything in your purchase history.

The UI is **bilingual (EN/RU)**: English shows prices in **USD** and New York cinemas, Russian shows **RUB**
and Moscow cinemas. Switch languages from the globe menu in the header.

> Русская версия: [README.md](./README.md)

---

## Highlights

**Booking flow**

- "Now showing" grid with large posters, **New** and **Promo −N%** badges, a featured block and "from" prices.
- Movie page with localised title/synopsis, rating, runtime, reviews and a **cinema → date → time** cascade
  that shows seats left and prices across the 14-day window.
- 8×12 seat map with seat classes (Standard / Premium / Recliner), legend and accessible labels.
- **5-minute seat hold** with a live countdown; expired holds release the seats automatically.
- Registration/login (JWT access + refresh, server-side revocation), protected routes, and a return to the
  exact seat selection after signing in.
- Checkout: promo code, itemised price (subtotal, discount, service fee, total), order countdown.
- Payment: card or PayPal, phone number, **6-digit SMS code**, 3 attempts, resend after 30 s.
- Ticket with QR code, PNG download/print, **My Tickets** (upcoming / history), refund up to 2 hours before
  the show with an automatic PSP reversal and an email receipt.
- **Guest checkout** without an account (the token is scoped to one booking; claim the account with a password
  later), sign-in via emailed **magic link**, phone verification over SMS.
- Loyalty: bonus points on purchases, redeem bonuses, referral codes (both sides get points), reviews with a
  rating on the movie page.
- Trailer modal, a **14-day** showtime calendar, and a cinemas page with a Leaflet map and IP-detected city.

**Product & engineering**

- RU/EN via i18next, currency follows the language, locale-aware dates, times and number formats.
- Localised cinema catalogues (Moscow ↔ New York), each with its own IANA timezone.
- Shared `shared/` package (types, zod schemas, money/discount maths, hall layout) so client and server
  can never disagree about a price.
- Strict TypeScript, type-aware ESLint, Prettier, Vitest (unit + component), Playwright E2E + axe WCAG 2.2 AA audit, k6 load, GitHub Actions CI.
- Storage: zero-config JSON **or** PostgreSQL (Prisma migrations, advisory locks) + Redis (seat holds, SSE
  pub/sub, BullMQ queues for SMS/email/PDF) — selected via `DATABASE_URL`/`REDIS_URL`.
- Payment providers: mock / YooKassa / Stripe / PayPal (signed, idempotent webhooks, circuit breaker) and
  PCI-safe Checkout.js / Stripe JS widgets with Apple Pay and Google Pay instead of a raw PAN field.
- SEO: server-rendered shell metadata (OG/canonical/hreflang + JSON-LD `Movie/ScreeningEvent/Offer/
  AggregateRating/BreadcrumbList` + noscript storefront), `sitemap.xml`, `robots.txt`, `/en/…` and `/ru/… URLs`.
- Observability & analytics: Prometheus metrics (`/api/metrics`) with threshold alerts (webhook + cooldowns),
  GTM/GA4/Yandex.Metrica with the full event funnel and UTM attribution in the audit log.
- JSON datastore with atomic writes, structured logging (pino) with masked phone numbers, rate limiting,
  request ids, CSRF guard, GDPR export/erase, audit log, centralised error handling, graceful shutdown.

---

## Stack & layout

```
movie-tickets/
├── shared/   # shared types, zod schemas, pricing/discounts, hall layout
├── server/   # Express + TypeScript API
│   └── src/{config,db,middleware,modules,services,utils}
├── client/   # React 19 + TypeScript + Vite + Tailwind 4
│   └── src/{api,components,context,i18n,lib,pages}
└── .github/workflows/ci.yml
```

express 4 · zod · pino · react 19 · react-router 6 · @tanstack/react-query 5 · react-hook-form ·
i18next · framer-motion · lucide-react · vitest + testing-library · tailwindcss 4.

---

## Quick start

```bash
npm install

# terminal 1 — API on http://localhost:4000
npm run dev:api

# terminal 2 — client on http://localhost:5173 (proxies /api to 4000)
npm run dev:web
```

Or both at once with `npm run dev`. Single-process mode (API serves the built SPA):

```bash
cd client && VITE_BASE=/ npm run build && cd ../server
SERVE_CLIENT=true NODE_ENV=development JWT_SECRET=$(openssl rand -base64 48) npm run start
```

Seeded data: 6 movies, 6 cinemas, 14 days of showtimes (`CATALOG_WINDOW_DAYS`), a deterministic set of pre-sold seats.

---

## Scripts

| Command                | Description                                      |
| ---------------------- | ------------------------------------------------ |
| `npm run dev`          | API + client in watch mode                       |
| `npm run build`        | Build client and server                          |
| `npm start`            | Run the API in production (serves `client/dist`) |
| `npm run typecheck`    | `tsc --noEmit` for client and server             |
| `npm run lint`         | Type-aware ESLint for client and server          |
| `npm run test`         | Vitest: server (166 API/unit) + client (28)      |
| `npm run test:pg -w @movie-tickets/server` | The same suite against Postgres + Redis |
| `npm run test:e2e -w @movie-tickets/client` | Playwright: purchase + sms + a11y (axe) |
| `npm run worker -w @movie-tickets/server` | BullMQ worker for the sms/email/pdf queues |
| `npm run format`       | Prettier --write                                 |
| `npm run format:check` | Formatting check used in CI                      |

---

## Environment

Templates: [`server/.env.example`](./server/.env.example), [`client/.env.example`](./client/.env.example).

Required in production: `JWT_SECRET` (signing keys), `CORS_ORIGIN` (allow-list), `NODE_ENV=production`
(HSTS, strict cookies, hides demo SMS codes).

Optional integrations:

| Variable                                                                               | Purpose                                      |
| -------------------------------------------------------------------------------------- | -------------------------------------------- |
| `TMDB_API_KEY`, `TMDB_LANGUAGE`, `TMDB_REGION`, `TMDB_IMAGE_BASE`, `TMDB_CACHE_TTL_MS` | Movie catalogue from TMDB                    |
| `SMS_PROVIDER`, `SMSRU_API_ID`/`SMSC_*`/`TWILIO_*`, `SMS_MAX_PER_HOUR` (legacy: `SMS_PROVIDER_URL`+`SMS_PROVIDER_TOKEN`) | 6-digit code delivery: smsru/smsc/twilio/generic/mock, 5 SMS/hour per number |
| `FX_RATES`                                                                             | Rates from the base currency: `RUB:90,USD:1` |
| `PROMO_CODES`                                                                          | `WELCOME10:10,CINEMA20:20`                   |
| `SERVE_CLIENT`, `DATA_DIR`, `LOG_LEVEL`, `TRUST_PROXY`, `*_RATE_LIMIT_*`               | See `.env.example`                           |

---

## Languages & currencies

- The header dropdown switches RU/EN, persists the choice in `localStorage` and syncs `<html lang>`;
  the browser language is used on the first visit.
- **EN → USD**, **RU → RUB** (rate from `FX_RATES`, default 1 USD = 90 RUB). Amounts live in base-currency
  cents; conversion happens on the server for charging and on the client for display, both using the same
  `shared/pricing.ts`, so the number never diverges.
- Everything user-facing is translated: UI copy, movie titles/synopses, cinema names and addresses,
  dates/times/durations, validation messages, API error messages and the downloaded ticket PNG.
- Sessions: access tokens live `JWT_ACCESS_TTL` (default `15m`; also accepts `30s`, `1h`, `7d`), refresh
  tokens rotate on every refresh. A rotated refresh token replayed within `REFRESH_REUSE_GRACE_MS` (60 s) is
  treated as a multi-tab race and simply re-rotated; after that window the sessions that existed at rotation
  time are revoked, but a newer sign-in always survives so the account can never be locked out. On the client,
  any 401 after a failed refresh drops the session and sends the user to `/login?from=…`, which returns them
  to the exact step they were on.
- Showtimes use the cinema's timezone (`America/New_York`, `Europe/Moscow`), so "18:30" is 18:30 on that
  city's wall clock.

---

## Movie catalogue: TMDB with a built-in fallback

**Yes — an external API can be used, and TMDB is wired in.** Get a key at
[themoviedb.org](https://www.themoviedb.org/settings/api) and set `TMDB_API_KEY`.

With a key the server fetches `/movie/now_playing` for every language (`en-US`, `ru-RU`), `/genre/movie/list`
and movie details (runtime), caches the result for `TMDB_CACHE_TTL_MS` and builds showtimes on top — so you get
real posters, titles, overviews, release dates and ratings in both languages.

Without a key (or if TMDB is down / returns 401) the app **silently falls back to the bundled catalogue** of
6 movies with posters and Russian translations. The active source is exposed by `GET /api/config`
(`catalogSource: "tmdb" | "local"`).

---

## Payments: cards, PayPal and the SMS code

1. Choose a method — card (Mir, Visa, Mastercard, Amex, UnionPay) or PayPal. The brand is detected from the BIN:
   `2200–2204` → Mir, `4…` → Visa, `51–55`/`2221–2720` → Mastercard, `62…` → UnionPay.
2. Enter a phone number (masked per country: `+7 (916) 123-45-67`, `+1 (202) 555-0123`); it is sent as E.164.
3. The card is **encrypted in the browser** and posted to `POST /api/payments/intents`.
4. The server validates Luhn and expiry, creates a payment intent, generates a **6-digit code** and sends it
   through the configured SMS gateway.
5. Six digit boxes accept the code: 3 attempts, 5-minute expiry, resend after 30 s.
6. `POST /api/payments/:id/verify` confirms the booking, marks the seats sold and issues the QR ticket.

**SMS gateway** — any HTTP provider. The server posts `{ "to", "text", "from" }` and sends
`Authorization: Bearer $SMS_PROVIDER_TOKEN` when a token is set (Twilio, SMS.ru, …).

Without `SMS_PROVIDER_URL` and outside production, the code is written to the server log and returned as
`devCode` so the demo is driveable. In production dev fields are never exposed and a missing gateway fails
the payment with "we could not send the code".

Test cards: `4242 4242 4242 4242` (Visa, success), `2200 0000 0000 0004` (Mir, success),
`4000 0000 0000 0002` (declined); PayPal with `decline@…` is declined.

---

## Payment data security

- **Client-side encryption.** Card number, name, expiry and CVC are encrypted in the browser with the API's
  **RSA-OAEP (SHA-256)** public key from `GET /api/config/payment-key`. Only ciphertext goes over the wire,
  and a secure context (HTTPS or localhost) is required — otherwise the form says so.
- **In-memory decryption.** The API decrypts the payload, validates it, stores **only the brand and last four
  digits**, and drops the plaintext. The key pair is generated at boot and never leaves the process.
- **No card numbers in storage or logs.** The full number never reaches `db.json` or the logs. Phone numbers
  are stored and displayed **masked** (`+7 *** ***-45-67`). Passwords use salted scrypt hashes; tokens are
  redacted in logs.
- **Masked in the UI too.** The card number is hidden as soon as the field loses focus (`•••• •••• •••• 4242`),
  CVC is a password field with a reveal toggle, and the SMS code uses four boxes with `one-time-code`.
- **Transport & headers.** HSTS in production, helmet with a CSP that allows TMDB posters, CORS allow-list,
  dedicated rate limits for auth and payments.
- **Price integrity.** The client previews totals; the server recomputes them with `computeQuote()` and
  ignores any price that arrives from the browser.

---

## Discounts, promo codes & badges

- **Promo codes** are configured via `PROMO_CODES` (`WELCOME10:10,CINEMA20:20,STUDENT15:15`), validated with
  `POST /api/promotions/validate`, and applied to an unpaid booking (`POST /api/bookings/:id/promo`,
  `DELETE` to remove) with a server-side reprice.
- **Automatic volume discount**: 4+ tickets → 10 %, 6+ → 15 %.
- **Movie promotion** (`discountPercent`) discounts a specific title.
- Offers **never stack** — the best one wins; the 6 % service fee is charged on the discounted subtotal.
- Badges: **New** (released within 45 days), **Promo −N%**, **Sold out** and seats-left counters on the
  grid, movie page and showtime pills.

---

## API

Base path `/api`; errors look like `{ "error": { "code": "seat_unavailable", "message": "…", "details": … } }`.

| Method          | Path                                     | Purpose                                                    |
| --------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `GET`           | `/health`, `/health/ready`               | Liveness / readiness                                       |
| `GET`           | `/config`                                | Locales, currencies, FX, payment methods, catalogue source |
| `GET`           | `/config/payment-key`                    | RSA-OAEP public key for card encryption                    |
| `POST`          | `/auth/register`, `/auth/login`          | Sign up / sign in (access + refresh)                       |
| `POST`          | `/auth/refresh`, `/auth/logout`          | Refresh / revoke session                                   |
| `GET`           | `/auth/me`                               | Current user                                               |
| `POST`          | `/auth/guest`, `/auth/guest/claim`       | Guest booking (token scoped to it) / claim with a password |
| `POST`          | `/auth/magic-link`, `/auth/magic-link/verify` | Passwordless sign-in via emailed link (single use, 15 min) |
| `POST`          | `/auth/phone/verify`, `/auth/phone/confirm` | Verify a phone number with an SMS code                   |
| `GET`           | `/auth/loyalty`                          | Bonus balance, history, personal referral code             |
| `GET`/`DELETE`  | `/auth/export`, `/auth/account`          | GDPR: export data / erase the account                      |
| `GET`           | `/movies?locale=en\|ru`                  | Listings with translations and showtime counts             |
| `GET`           | `/movies/:slug?locale=`                  | Movie + cinemas + dates + times + prices                   |
| `GET`/`POST`    | `/movies/:slug/reviews`                  | Reviews: list with aggregate / submit (ticket required)    |
| `GET`           | `/theaters?locale=`                      | Cinemas for the selected city                              |
| `GET`           | `/geo`, `/cities`                        | IP-detected region (city, currency) / city list            |
| `GET`           | `/showtimes/:id`                         | Showtime + availability (+ movie discount preview)         |
| `GET`           | `/showtimes/:id/seats`                   | Seat map                                                   |
| `POST`          | `/showtimes/:id/holds`                   | Hold seats for 5 minutes (`X-Hold-Token`)                  |
| `DELETE`        | `/showtimes/:id/holds`                   | Release the hold                                           |
| `GET`           | `/bookings?scope=upcoming\|history\|all` | List bookings                                              |
| `POST`          | `/bookings`                              | Create a booking (`showtimeId`, `seatIds`, `promoCode`)    |
| `GET`           | `/bookings/:id`                          | Ticket                                                     |
| `POST`/`DELETE` | `/bookings/:id/promo`                    | Apply / remove a promo code                                |
| `POST`          | `/bookings/:id/refund`                   | Refund (PSP reversal + email; up to 2 h before the show)   |
| `POST`          | `/bookings/:id/cancel`                   | Cancel (legacy — refunds too)                              |
| `POST`          | `/bookings/:id/receipt`                  | Re-send the PDF receipt by email                           |
| `POST`          | `/webhooks/:provider`                    | YooKassa/Stripe/PayPal webhooks (signature + idempotency)  |
| `GET`           | `/metrics`, `/metrics/summary`, `/metrics/alerts` | Prometheus metrics and fired alerts (`METRICS_TOKEN`) |
| `GET`           | `/sitemap.xml`, `/robots.txt`            | SEO files (hreflang alternates, private-route Disallow)    |
| `GET`           | `/promotions`                            | Active promo codes                                         |
| `POST`          | `/promotions/validate`                   | Validate a code and get the percentage                     |
| `POST`          | `/payments/intents`                      | Create a payment (encrypted card / PayPal + phone)         |
| `GET`           | `/payments/:id`                          | Payment status                                             |
| `POST`          | `/payments/:id/verify`                   | Confirm the 6-digit code → ticket                          |
| `POST`          | `/payments/:id/resend`                   | Resend the code                                            |

---

## Tests, linting, CI

```bash
npm run test          # 166 server API/unit tests (auth, guest, magic link, booking,
                      #   payment, refund, loyalty, catalog-db, observability, OTP,
                      #   webhooks, SSE, race-hold) + 28 client tests
npm run lint          # type-aware ESLint: 0 errors
npm run typecheck     # tsc --noEmit (strict)
npm run format:check  # Prettier
```

Covered: money and locale formatting, phone masks, card helpers (Luhn, brands, masking), the seat-hold
countdown regression, the seat map component, the full API flow (register → hold → book → pay → tickets →
cancel), promo codes and discounts, Mir/PayPal, and rejection of unencrypted card payloads.

The Playwright E2E suite (Chromium, CI job `e2e`) runs 3 specs: `purchase` (register → seats → promo →
card → SMS code → QR ticket), `sms` (wrong code → resend → purchase) and `a11y` (axe-core over home, movie,
cinemas, login and the seat map — WCAG 2.2 AA, zero violations).

Load (k6, `k6/booking-spike.js`): a 1000-VU hot race for one seat — exactly 1 winner, 0 double-bookings,
p95 4–6 ms; `BASE_URL=http://localhost:4001 k6 run k6/booking-spike.js`.

CI (`.github/workflows/ci.yml`): `npm ci` → Prettier → typecheck → ESLint → tests → client build.

---

## Deployment

**Single process (Render, Fly, Railway, VPS):**

```bash
npm ci
cd client && VITE_BASE=/ npm run build && cd ..
npm run build -w @movie-tickets/server
NODE_ENV=production JWT_SECRET=... SERVE_CLIENT=true CORS_ORIGIN=https://your-domain npm start
```

**Split:** serve `client/dist` statically (Nginx/Netlify/Vercel) and proxy `/api` to the API, setting
`VITE_API_URL`. For GitHub Pages use `VITE_BASE=/movie-tickets/` (the default for production builds);
`client/public/404.html` provides the SPA fallback.

**Production checklist:** set `JWT_SECRET`, `CORS_ORIGIN`, `NODE_ENV=production`, `APP_PUBLIC_URL`;
configure an SMS provider (`SMS_PROVIDER=smsru|smsc|twilio` plus credentials — `mock` is refused in
production) and email (`EMAIL_PROVIDER`/`SMTP_*` or `SENDGRID_API_KEY`); optionally `TMDB_API_KEY`,
`PROMO_CODES`, `GTM_ID`/`GA4_ID`/`YM_ID`, `ALERT_WEBHOOK_URL` and `METRICS_TOKEN`; terminate TLS
(without HTTPS the browser blocks `crypto.subtle` and the PSP widgets will not mount).

Storage is switched by variables, not by editing code: `DATABASE_URL` → Postgres through Prisma
(`npm run prisma:migrate -w @movie-tickets/server`; in Docker migrations run at boot) and `REDIS_URL` →
seat holds, SSE pub/sub and BullMQ queues. Each falls back independently (Postgres unreachable → JSON,
Redis unreachable → in-memory). `docker compose up --build` starts `postgres:17 + redis:7 + api + worker`.

---

## License

MIT. Demo project: no real processing happens and no money moves.
Movie data (when a TMDB key is configured) comes from The Movie Database — this product uses the TMDB API
but is not endorsed or certified by TMDB.
