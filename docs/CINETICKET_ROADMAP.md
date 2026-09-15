# CineTicket — концепция, архитектура и roadmap (поверх текущего стека)

> Решение: стек **не переписываем на Next.js** — оставляем рабочий `client (React + Vite + TS) + server (Express + TS) + shared`,
> а недостающее из ТЗ добавляем слоями: PostgreSQL + Prisma, Redis, провайдеры платежей/SMS, очереди, тесты.
> Это быстрее, дешевле и не ломает уже работающую оплату.

Легенда статусов: ✅ есть · 🟡 частично · ❌ нет (в roadmap).

---

## 1. Концепция и архитектура (10 пунктов)

1. **Монorepo `client / server / shared`.** Общие типы, Zod-схемы и прайсинг лежат в `shared/` и используются обеими
   сторонами — контракт API невозможно рассинхронизировать. ✅
2. **Слои сервера:** `modules/` (роуты, тонкие) → `services/` (бизнес-логика) → `db/` (хранилище через
   интерфейс `Repositories`). Реализации: `db/json` (zero-config) и `db/prisma` (PostgreSQL, миграции,
   advisory-lock на checkout). Выбор — `DATABASE_URL`, сервисы интерфейс не меняли. ✅
3. **Паттерн Strategy для платежей и SMS:** ✅ `PaymentProvider` + фабрика (`mock | yookassa | stripe | paypal`),
   вебхуки с проверкой подписи и идемпотентностью, Circuit Breaker. ✅ `SmsProvider` + фабрика
   (`mock | generic | smsru | smsc | twilio`), OTP-лимиты ТЗ в `OtpCode` + Redis.
4. **State для заказов:** `pending → confirmed → cancelled | expired`, платежи `requires_code → succeeded | failed`.
   Переходы только через сервисы (`confirmBooking`, `verifyCode`), никаких прямых апдейтов статуса из роутов. ✅
5. **Saga оплаты:** `createIntent → SMS-код → verify → confirmBooking → recordPayment`. Каждый шаг идемпотентен,
   повторный `createIntent` возвращает живой интент, а не создаёт второй. ✅
6. **Блокировки мест:** `SeatHoldStore` — Redis (Lua `replace`/`release` с проверкой владельца, TTL)
   или in-memory с той же семантикой; выбор — `REDIS_URL`. SSE-инвалидация карты мест
   (`GET /api/showtimes/:id/stream`, событие `seats`) + `useSeatStream` на клиенте; поллинг 15с — fallback. ✅
7. **Наблюдаемость:** `pino` + `X-Request-Id` на каждом запросе, секреты вырезаны `redact`. Метрики
   (latency по route-шаблонам, 401-rate, payment_failed, seat-конфликты, очереди, CB-состояния) — собственный
   Prometheus-реестр `utils/metrics.ts` + `GET /api/metrics|/summary|/alerts`; пороги — `ALERT_*`, правила с
   кулдауном и POST в `ALERT_WEBHOOK_URL` (`services/alerts.ts`), тесты `observability.test.ts`. ✅ (п.9, 2026-09-14)
8. **Очереди:** BullMQ + Redis (очереди `sms`, `email`, `pdf`), воркер `npm run worker`, ретраи 5×backoff ✅ (п.5, 2026-09-14).
   Без Redis — тот же пайплайн исполняется inline в процессе API (`QUEUES_DRIVER`). Вебхуки оставлены синхронными:
   они идемпотентны и быстрые, а ответ PSP нужен сразу.
9. **i18n:** `react-i18next`, словари `ru/en`, валюта/даты через `Intl` (`money()`, `formatShowDateTime`).
   URL-префиксы `/ru/ /en/` (роутер с `basename` по локали, rewrite «голого» URL in-place) и `hreflang`
   (клиентский `useSeo` + серверные alternates/`x-default` в sitemap) ✅ (п.9, 2026-09-14).
10. **Тестовая пирамида:** Vitest unit + API-тесты через supertest ✅, Playwright E2E (3 спека: purchase, sms, a11y/axe) ✅, k6 load ✅ (п.4, 2026-09-14).

---

## 2. Схема БД (Prisma, PostgreSQL — реализовано в `server/prisma/`)

Реализовано полностью (п.2–3 + п.9, 2026-09-14): ядро (`User/Session/Booking/Payment/WebhookEvent`),
`OtpCode`, аудит-лог, каталог (`City/Cinema/Hall/Movie/Screening/Seat`, миграция `0004_catalog` — сид при
старте и раздача из БД) и `Refund/Ticket/Promocode/BonusTransaction/Referral/Review` (миграция
`0005_tickets_loyalty`). JSON-адаптер хранит те же сущности; схема ниже — как построена.

```prisma
// prisma/schema.prisma
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }
generator client { provider = "prisma-client-js" }

enum BookingStatus { pending confirmed cancelled expired }
enum PaymentStatus { requires_code succeeded failed refunded }
enum TicketStatus { valid used refunded }

model User {
  id           String   @id @default(cuid())
  name         String
  email        String   @unique
  phone        String?  @unique
  phoneVerifiedAt DateTime?
  passwordHash String
  createdAt    DateTime @default(now())
  sessions     Session[]
  otpCodes     OtpCode[]
  bookings     Booking[]
  bonus        BonusTransaction[]
  reviews      Review[]
  referrals    Referral[] @relation("referrer")
  referredBy   Referral?  @relation("referred")
}

model Session {
  id         String    @id @default(cuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash  String    @unique
  expiresAt  DateTime
  revokedAt  DateTime?
  replacedBy String?
  userAgent  String?
  createdAt  DateTime  @default(now())
  @@index([userId])
}

model OtpCode { // хеш argon2, TTL 5 мин, попытки — в колонке
  id         String   @id @default(cuid())
  userId     String?
  user       User?    @relation(fields: [userId], references: [id], onDelete: Cascade)
  phone      String
  purpose    String   // "payment" | "phone_verify" | "login"
  codeHash   String
  expiresAt  DateTime
  attemptsLeft Int     @default(3)
  consumedAt DateTime?
  createdAt  DateTime  @default(now())
  @@index([phone, purpose])
}

model City   { id String @id @default(cuid()); slug String @unique; nameRu String; nameEn String; cinemas Cinema[] }
model Cinema {
  id String @id @default(cuid()); cityId String; city City @relation(fields: [cityId], references: [id])
  slug String @unique; nameRu String; nameEn String; addressRu String; addressEn String
  lat Float?; lng Float?; halls Hall[]
  @@index([cityId])
}
model Hall   { id String @id @default(cuid()); cinemaId String; cinema Cinema @relation(fields: [cinemaId], references: [id]); nameRu String; nameEn String; format String; rows Int; cols Int; seats Seat[]; screenings Screening[] }

model Movie {
  id String @id @default(cuid()); slug String @unique
  titleRu String; titleEn String; genreRu String; genreEn String
  durationMin Int; ageRating String; descRu String; descEn String
  posterUrl String?; trailerUrl String?
  ratingKp Float?; ratingImdb Float?; ratingLocal Float?
  badges String[] // NEW PROMO TOP IMAX PREMIERE
  discountPercent Int @default(0)
  screenings Screening[]; reviews Review[]
}

model Screening {
  id String @id @default(cuid()); movieId String; movie Movie @relation(fields: [movieId], references: [id])
  hallId String; hall Hall @relation(fields: [hallId], references: [id])
  startsAt DateTime; basePriceCents Int; currency String @default("RUB")
  bookings Booking[]
  @@index([movieId, startsAt]); @@index([hallId, startsAt])
}

model Seat {
  id String @id @default(cuid()); hallId String; hall Hall @relation(fields: [hallId], references: [id])
  row Int; number Int; seatClass String; priceDeltaCents Int @default(0)
  @@unique([hallId, row, number])
}

model Booking {
  id String @id @default(cuid()); code String @unique // K497-45UL
  userId String; user User @relation(fields: [userId], references: [id])
  screeningId String; screening Screening @relation(fields: [screeningId], references: [id])
  status BookingStatus @default(pending)
  seatIds String[]; quoteJson Json; currency String
  promoCode String?
  expiresAt DateTime
  payments Payment[]; tickets Ticket[]; refunds Refund[]
  createdAt DateTime @default(now())
  @@index([userId, status]); @@index([screeningId])
}

model Payment {
  id String @id @default(cuid()); bookingId String; booking Booking @relation(fields: [bookingId], references: [id])
  provider String; providerRef String? @unique
  method String; status PaymentStatus @default(requires_code)
  amountCents Int; currency String
  cardBrand String?; cardLast4 String?
  phoneMasked String?
  idempotencyKey String @unique
  createdAt DateTime @default(now())
  @@index([bookingId])
}

model WebhookEvent { // идемпотентность вебхуков
  id String @id @default(cuid()); provider String; eventId String
  payload Json; processedAt DateTime?
  @@unique([provider, eventId])
}

model Refund  { id String @id @default(cuid()); bookingId String; booking Booking @relation(fields: [bookingId], references: [id]); amountCents Int; reason String; createdAt DateTime @default(now()) }
model Ticket  { id String @id @default(cuid()); bookingId String; booking Booking @relation(fields: [bookingId], references: [id]); qrCode String @unique; seatLabel String; status TicketStatus @default(valid) }
model Promocode { id String @id @default(cuid()); code String @unique; percent Int; minSeats Int @default(1); validFrom DateTime?; validTo DateTime?; usageLimit Int?; used Int @default(0) }
model BonusTransaction { id String @id @default(cuid()); userId String; user User @relation(fields: [userId], references: [id]); delta Int; reason String; createdAt DateTime @default(now()); @@index([userId]) }
model Referral { id String @id @default(cuid()); referrerId String; referrer User @relation("referrer", fields: [referrerId], references: [id]); referredId String @unique; referred User @relation("referred", fields: [referredId], references: [id]) }
model Review { id String @id @default(cuid()); movieId String; movie Movie @relation(fields: [movieId], references: [id]); userId String; user User @relation(fields: [userId], references: [id]); rating Int; text String; createdAt DateTime @default(now()); @@unique([movieId, userId]) }

model AuditLog { // ✅ п.8 (userId без FK, meta без PII — лог переживает стирание аккаунта)
  id String @id @default(cuid()); actorId String?; action String; entity String; entityId String?
  meta Json?; createdAt DateTime @default(now())
  @@index([action, createdAt])
}
```

---

## 3. Дерево проекта (целевое)

```text
movie-tickets/
├── client/src/                      # React + Vite (есть)
│   ├── api/ pages/ components/ context/ hooks/ i18n/ lib/
│   └── e2e/                         # ✅ Playwright: purchase.spec.ts, sms.spec.ts (2/2 + CI job e2e)
├── server/src/
│   ├── modules/                     # ✅ роуты: auth, movies, showtimes, bookings, payments, ...
│   │   └── webhooks.ts              # ✅ приём вебхуков провайдеров
│   ├── services/                    # ✅ authService, bookingService, paymentService, smsService, ...
│   │   ├── payments/                # ✅ yookassa.ts, stripe.ts, paypal.ts, mock + factory.ts
│   │   └── sms/                     # ✅ mock, generic, smsru, smsc, twilio + factory (п.3)
│   ├── db/                          # ✅ репозитории: json/ + prisma/ поверх schema.prisma
│   ├── queues/                      # ✅ queueService + pipeline + runner (sms/email/pdf, BullMQ|inline, п.5)
│   └── geo/                         # ✅ провайдеры mock/ipapi/sypex/maxmind + resolveRegion + attachRegion (п.6)
├── worker (src/worker.ts + compose) # ✅ процесс воркеров (п.5)
├── prisma/ schema.prisma  migrations/ # ✅
├── shared/                          # ✅ типы, схемы, прайсинг
├── k6/ booking-spike.js             # ✅ hot race 1000 VUs + spike (п.4)
├── docker-compose.yml               # ✅ postgres + redis + api
└── docs/CINETICKET_ROADMAP.md       # этот файл
```

---

## 4. Backend

### 4.1 API (есть, все ответы `{ data }` / `{ error: { code, message, details, requestId } }`)

| Метод       | Путь                                                            | Auth    | Назначение              |
| ----------- | --------------------------------------------------------------- | ------- | ----------------------- |
| POST        | `/api/auth/register                                             | login   | refresh                 | logout` | —   | сессии, ротация refresh |
| GET         | `/api/auth/me`                                                  | ✅      | профиль                 |
| GET         | `/api/movies`, `/api/movies/:slug`                              | —       | каталог, сеансы фильма  |
| GET         | `/api/theaters?locale=`                                         | —       | кинотеатры по региону   |
| GET         | `/api/showtimes/:id`, `.../seats`                               | —       | сеанс, карта мест       |
| POST/DELETE | `/api/showtimes/:id/holds`                                      | hold    | hold мест (TTL)         |
| GET/POST    | `/api/bookings`, `/api/bookings/:id`, `.../cancel`, `.../promo` | ✅      | заказы                  |
| POST        | `/api/payments/intents`, `.../:id/verify`, `.../:id/resend`     | ✅      | оплата + SMS-код        |
| POST        | `/api/webhooks/:provider`                                       | подпись | вебхуки ЮKassa/Stripe/PayPal (✅ п.1) |
| POST        | `/api/auth/guest`, `/api/auth/guest/claim`                      | —       | гостевой checkout, claim в аккаунт (✅ п.9) |
| POST        | `/api/auth/magic-link`, `.../verify`                            | —       | passwordless-вход по письму (✅ п.9)  |
| POST        | `/api/auth/phone/verify`, `.../confirm`                         | ✅      | верификация телефона по OTP (✅ п.9)  |
| GET         | `/api/auth/loyalty`, `/api/auth/export`; DELETE `/api/auth/account` | ✅  | бонусы/рефералы, GDPR (✅ п.8–9)      |
| POST        | `/api/bookings/:id/refund`                                      | ✅      | возврат с PSP-reversal (✅ п.7)       |
| GET/POST    | `/api/movies/:slug/reviews`                                     | —/✅    | отзывы и агрегированный рейтинг (✅ п.9) |
| GET         | `/api/geo`, `/api/cities`, `/api/theaters?city=`                | —       | IP-гео, города (✅ п.6)               |
| GET         | `/api/metrics`, `.../summary`, `.../alerts`                     | token   | Prometheus + алерты (✅ п.9)          |
| GET         | `/sitemap.xml`, `/robots.txt`                                   | —       | SEO-файлы (✅ п.9)                    |
| GET         | `/api/config`, `/api/config/payment-key`                        | —       | валюты, RSA-ключ, аналитика, виджет   |

### 4.2 PaymentProvider (roadmap, интерфейс)

```ts
export interface ChargeInput {
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  returnUrl?: string;
  methodData: unknown;
}
export interface ChargeResult {
  providerRef: string;
  status: "pending" | "succeeded" | "requires_action";
  actionUrl?: string;
}
export interface PaymentProvider {
  readonly name: "yookassa" | "stripe" | "paypal" | "mock";
  charge(input: ChargeInput): Promise<ChargeResult>;
  refund(providerRef: string, amountCents: number): Promise<void>;
  verifyWebhook(
    rawBody: Buffer,
    headers: Headers,
  ): Promise<{ eventId: string; providerRef: string; status: string }>;
}
// server/src/services/payments/factory.ts
export function paymentProvider(name = process.env.PAYMENTS_PROVIDER ?? "mock"): PaymentProvider {
  switch (name) {
    case "yookassa":
      return new YooKassaProvider();
    case "stripe":
      return new StripeProvider();
    case "paypal":
      return new PayPalProvider();
    default:
      return new MockProvider();
  }
}
```

Правила: идемпотентность по `idempotencyKey` (таблица `Payment`), вебхук — по паре `(provider, eventId)`
(таблица `WebhookEvent`), проверка подписи до любой бизнес-логики, ретраи с экспоненциальной задержкой,
Circuit Breaker на шлюз (после N ошибок — short-circuit + 503 с `Retry-After`).

### 4.3 SmsProvider (реализовано ✅)

```ts
export interface SmsProvider {
  readonly name: "smsru" | "smsc" | "twilio" | "generic" | "mock";
  send(to: string, text: string): Promise<{ delivered: boolean; messageId?: string }>;
}
```

Реализовано в `services/sms/`: провайдеры `mock | generic | smsru | smsc | twilio` + фабрика (`SMS_PROVIDER`;
legacy `SMS_PROVIDER_URL` без `SMS_PROVIDER` → `generic`; mock в production запрещён).
Лимиты по ТЗ — в `OtpCode` (argon2-хеш, TTL, попытки, `purpose`) + Redis-счётчики `sms:rl:{phone}`:
6 цифр, TTL 5 мин, 3 попытки, 5 SMS/час на номер (429 `rate_limited`).

### 4.4 Redis-локи мест (реализовано; in-memory — запасной режим)

```lua
-- replace: Lua — проверка владельца, сброс старых мест, SET <key> <{u,t}> PX <ttl>, SADD owner-set
-- release — Lua с проверкой owner (защита от снятия чужого лока)
-- booking: hold (Lua) → PostgreSQL INSERT под pg_advisory_xact_lock → подтвердить
```

Публикация `seats:<showtime>` в Redis Pub/Sub → SSE `/api/showtimes/:id/stream` → клиент инвалидирует карту мест
(`useSeatStream` + refetch; событие без payload, маскирование per-viewer не утекает).
Без `REDIS_URL` (или при недоступности) — `MemorySeatHoldStore` + in-process шина с той же семантикой.
Лимит 6 мест — уже (`MAX_SEATS_PER_BOOKING`, сервер + клиент).

---

## 5. Frontend

| Экран                                                       | Статус                                                                                         | Что доделать                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Каталог (`HomePage`), карточка (`MovieCard`, `Badge`)       | ✅ постер, жанр, длительность, возраст, рейтинги, бейджи, фильтры, поиск                       | — (трейлер-модалка ✅ п.9: `TrailerModal` на странице фильма) |
| Кинотеатры                                                  | ✅ /cinemas: пилюли городов (дефолт из /api/geo), Leaflet-карта, карточки (п.6)                | —                                            |
| Сеансы (`ScreeningPicker`)                                  | ✅ дни/времена/цены/остаток                                                                    | — (календарь 14 дней ✅ п.9: `CATALOG_WINDOW_DAYS=14`, лента на всё окно) |
| Зал (`SeatMap`, SVG)                                        | ✅ статусы, hold-синхронизация, лимит 6, aria-label `Ряд/место/класс/статус`                   | SSE (`useSeatStream`, поллинг — fallback) ✅ |
| Checkout                                                    | ✅ промокод серверный, таймер 15 мин                                                           | — (гостевой checkout + SMS ✅ п.9: `GuestCheckoutDialog` → `POST /api/auth/guest`, токен на бронь, claim-в-аккаунт) |
| Оплата (`PaymentForm`=`CardForm`, `OtpInput`)               | ✅ МИР/Visa/MC/PayPal(mock), RSA-шифрование карты, SMS-код, ресенд-кулдаун                     | — (виджеты ЮKassa/Stripe + Apple/Google Pay ✅ п.9: `CardWidgetForm`, `CARD_WIDGET`, token-only) |
| История (`MyTicketsPage`, `TicketCard`, QR, PDF-скачивание) | ✅ статусы, фильтры, повторная отправка чека (п.5), возврат из UI с PSP-reversal + email (п.7) | —                                            |
| i18n                                                        | ✅ `ru/en`, `Intl`-даты/валюты                                                                 | — (URL `/ru/ /en/` + `hreflang` ✅ п.9)      |

---

## 6. Интеграции

| Система                   | Сейчас                                                                                                | Целевое                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------- |
| ЮKassa (МИР, СБП)         | ✅ провайдер + 3DS через `requires_action` + webhook с API-подтверждением                             | — (виджет Checkout.js вместо raw PAN ✅ п.9: `CARD_WIDGET`, `YOOKASSA_PUBLIC_KEY`, `payment_token`) |
| Stripe (Visa/MC)          | ✅ провайдер + PaymentIntent + HMAC-вебхуки + 3DS                                                     | — (PaymentElement/Stripe JS ✅ п.9: `STRIPE_PUBLISHABLE_KEY`, `automatic_payment_methods`; Apple/Google Pay — кнопки-кошельки) |
| PayPal                    | ✅ Orders API + approve-redirect + capture в вебхуке                                                  | —                                       |
| SMS.ru / SMSC.ru / Twilio | ✅ провайдеры + фабрика + rate limit 5/час (429) + очередь BullMQ (п.5)                               | —                                       |
| IP-гео                    | ✅ mock/ipapi/sypex/maxmind + тотальный resolveRegion (кэш 5 мин) + attachRegion → город/валюта (п.6) | —                                       |
| Email                     | ✅ SMTP/SendGrid/mock + шаблоны билет/чек + QR + PDF-чек (п.5)                                        | — (magic link ✅ п.9: `POST /api/auth/magic-link` + verify, одноразовый, TTL 15 мин, не раскрывает аккаунт) |
| TMDB                      | ✅ постеры/рейтинги с кэшем                                                                           | —                                       |

Sandbox-режим: `PAYMENTS_PROVIDER=mock`, `SMS_PROVIDER_URL=` (код в логе + `devCode` в ответе, только не-prod),
тестовые карты `4242…`, `2200…`, decline-карты `4000000000000002`.

---

## 7. Безопасность, SEO, A11y, аналитика

**Безопасность:** ✅ PCI — PAN/CVV только в RSA-шифрованном виде, в памяти, ни на диск, ни в логи;
✅ пароли — salted scrypt (переезд на argon2id — 1 функция в `crypto.ts`); ✅ JWT access(15м)+rotate-refresh;
✅ rate limiting (глобальный/auth/payment); ✅ Zod на сервере; ✅ CSP/HSTS/Referrer-Policy; ✅ `redact` секретов.
✅ CSRF-guard для cookie-мутаций (требует `X-Requested-With`, клиент шлёт всегда; double-submit не понадобился) (п.8),
✅ OTP argon2id (п.3),
✅ GDPR-экспорт/удаление (`DELETE /api/auth/account` + `GET /api/auth/export`, страница /account) (п.8),
✅ аудит-лог (`AuditLog`: register/login/payment/refund/export/delete, без PII в meta) (п.8).

**SEO:** ✅ (п.9, 2026-09-14). Пререндер витрины — серверный SEO-слой (`services/seo.ts` + `modules/seo.ts`):
при `SERVE_CLIENT` каждый маршрут отдаётся шеллом с живыми title/description/canonical/OG, JSON-LD
(`Movie/ScreeningEvent/MovieTheater/Offer/AggregateRating/BreadcrumbList` + `WebSite/SearchAction`, `VideoObject`)
и `noscript`-витриной из каталога; `GET /sitemap.xml` (все маршруты × ru/en + hreflang + x-default),
`GET /robots.txt` (Disallow приватных маршрутов); на клиенте то же держит `useSeo` + `lib/seoLd.ts`;
чистые URL `/movies/:slug` ✅ уже.

**A11y (WCAG 2.2 AA):** ✅ aria-label мест, `aria-live` тосты, фокус-стили, клавиатурная карта мест,
тач-цели ≥44px; ✅ `prefers-reduced-motion` в CSS (п.9); ✅ аудит axe в CI (п.9: `@axe-core/playwright`,
`e2e/a11y.spec.ts` — home/movie/cinemas/login/seat map, теги wcag2a…wcag22aa; по итогам аудита исправлены
контраст secondary-текстов, danger-кнопка (red-600) и хит-зона map-пинов (28px, target-size)).

**Аналитика:** ✅ (п.9, 2026-09-14). GA4 + Метрика через GTM (`AnalyticsBridge`, id приходят из
`GET /api/config` — `GTM_ID/GA4_ID/YM_ID`, без пересборки клиента); события `view_movie, view_showtime,
view_seat_map, select_seat, begin_checkout, add_payment_info, sms_code_sent, sms_code_verified, purchase,
payment_failed, refund, sign_up, login, guest_checkout, magic_link_requested, phone_verified, trailer_open,
review_submitted, promo_applied` + `page_view` на SPA-переход; UTM: захват на лендинге → `X-Utm` →
`requestContext` → `AuditLog.meta.utm`.

---

## 8. Тесты

| Уровень          | Есть                                                                                                    | Добавить                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Unit (Vitest)    | ✅ прайсинг, seats, card, localize, countdown, email-провайдеры, PDF-чеки                               | OTP-лимиты ✅, провайдеры ✅, вебхук-подписи ✅     |
| API (supertest)  | ✅ 166 тестов: auth(+guest/magic-link/phone)/booking/payment/refund/loyalty/catalog-db/observability/… (JSON и PG/Redis; 2 bullmq-теста скипаются без Redis). Локально на PostgreSQL 17 + Redis: 168/168 passed, `prisma migrate deploy` — все 5 миграций | —                                                   |
| E2E (Playwright) | ✅ 3 спека: `purchase` + `sms` + `a11y` (axe, WCAG 2.2 AA) — 4/4, CI job `e2e` (Chromium)               | дальше — матрица браузеров                          |
| Load (k6)        | ✅ `booking-spike.js`: hot race 1000 VUs = ровно 1 winner, spike p95 4–6ms, 0 ошибок; 2026-09-15 повтор на PG 17 + Redis: 100% checks, p95 ≤ 102ms, exit 0 | —                                                   |

Реализован (п.4, 2026-09-14): `k6/booking-spike.js` — два сценария на разных сеансах.
`hot_seat_race`: HOT_VUS (по умолчанию 1000) по одной попытке на одно место, порог
`hot_seat_wins: count == 1` — распределённое доказательство отсутствия double-book.
`booking_spike`: чтение карты + hold 1–2 мест с рампой до SPIKE_VUS, пороги `spike_errors == 0`,
p95 < 500ms. Факт прогона: 1000/1000 попыток, ровно 1 winner, p95 seats 6ms / holds 4ms, 0 ошибок.

---

## 9. Конфиги

```yaml
# docker-compose.yml (roadmap)
services:
  postgres:
    {
      image: postgres:16,
      environment: { POSTGRES_DB: cinetickets, POSTGRES_PASSWORD: secret },
      volumes: [pg:/var/lib/postgresql/data],
      ports: ["5432:5432"],
    }
  redis: { image: redis:7-alpine, ports: ["6379:6379"] }
  api:
    {
      build: .,
      command: node dist/server/src/index.js,
      env_file: server/.env,
      depends_on: [postgres, redis],
      ports: ["4000:4000"],
    }
  worker:
    { build: ., command: node dist/worker/index.js, env_file: server/.env, depends_on: [postgres, redis] }
volumes: { pg: {} }
```

`.env` дополнения: `DATABASE_URL`, `REDIS_URL`, `PAYMENTS_PROVIDER`, `YOOKASSA_*`, `STRIPE_*`, `PAYPAL_*`,
`SMS_PROVIDER=smsru|twilio`, `SMSRU_API_ID`, `TWILIO_*`, `GTM_ID` ✅ (п.9 — вместе с `GA4_ID/YM_ID`,
`METRICS_*/ALERTS_*/ALERT_*`, `MAGIC_LINK_TTL_MINUTES`, `GUEST_TOKEN_TTL_HOURS`, `CATALOG_WINDOW_DAYS`,
`BONUS_PERCENT/REFERRAL_*`, `CARD_WIDGET`, `YOOKASSA_PUBLIC_KEY/STRIPE_PUBLISHABLE_KEY` — всё задокументировано
в `server/.env.example`)
(+ `EMAIL_*`, `SMTP_*`, `SENDGRID_API_KEY`, `QUEUES_DRIVER` — ✅ п.5; `GEO_PROVIDER`, `GEO_MMDB_PATH`, `GEO_TIMEOUT_MS` — ✅ п.6;
`ARGON2_*` не понадобились — дефолты argon2id в коде).

---

## 10. README: запуск, sandbox, деплой

```bash
npm install
npm run dev          # api :4000 + web :5173 (прокси /api)
npm test             # server 85 (2 bullmq-теста скипаются без Redis) + client 23
npm run test:pg -w @movie-tickets/server  # все 85 против Postgres + Redis
npm run test:e2e -w @movie-tickets/client  # Playwright: purchase + sms (Chromium)
BASE_URL=http://localhost:4001 k6 run k6/booking-spike.js  # hot race 1000 VUs + spike
npm run worker -w @movie-tickets/server  # BullMQ-воркер sms/email/pdf (нужен REDIS_URL)
node e2e-payment.mjs # сквозная покупка по HTTP (API_URL=.../api)
docker compose up --build  # api :4000 + postgres + redis (.env из .env.example)
```

Sandbox: `PAYMENTS_PROVIDER=mock`, `SMS_PROVIDER_URL=` → SMS-код возвращается в `devCode` и пишется в лог;
тест-карта `4242 4242 4242 4242`, МИР `2200 0000 0000 0004`, decline `4000000000000002`.
Демо-аккаунт для кликов: зарегистрируйтесь на `/register` (пароль ≥8 символов, цифра+буква).

Деплой (single-container): `SERVE_CLIENT=true npm run build && npm start` — API отдаёт `client/dist`.
Compose: `postgres:17 + redis:7 + api + worker` (миграции при старте, данные в volumes `pgdata/redisdata/apidata`).
Раздельный: клиент на static-хостинг с `VITE_API_URL=https://api…`, сервер с `CORS_ORIGIN=https://web…`,
`JWT_SECRET` (openssl rand -base64 48), `TRUST_PROXY=true` за reverse-proxy.

---

## 11. Чек-лист самопроверки

- [x] Два пользователя выбрали одно место одновременно → второй получает `409 seat_unavailable` (hold проверяет
      владельца; тест «Those seats are now held» ✅). На Redis — тот же ответ через Lua + `pg_advisory_xact_lock`
      (проверено `test:pg` ✅).
- [x] Вебхук пришёл дважды → `(provider, eventId)` уникален, повтор — `200 already_processed` без повторного списания
      ✅ реализовано в `modules/webhooks.ts` + `services/payments/webhooks.ts`, покрыто тестами `webhooks.test.ts`.
- [x] Лок истёк во время оплаты → `createBooking`/`createIntent` сверяют hold/статус; просроченный `pending` помечается
      `expired`, места возвращаются в продажу, деньги не списываются (интент создаётся только на живой `pending`).
- [x] Слепой пользователь сможет купить билет → карта мест полностью клавиатурная, у каждого места
      `aria-label «Ряд 5, место 7, VIP, свободно»`, статусы объявляются через `aria-live`, фокус видим.
- [x] Заголовок `Authorization` потерян прокси → клиент дублирует токен в `X-Auth-Token`, сервер принимает оба + cookie; регрессионные тесты ✅, E2E без `Authorization` ✅.
- [x] OTP: 6 цифр, TTL 5 мин, 3 попытки, 5 SMS/час — 2026-09-14 (п.3: `OtpCode` + argon2id, провайдеры mock/generic/smsru/smsc/twilio, квота Redis/memory).
- [x] Нагрузка 1000 броней — 2026-09-14 (п.4: hot race 1000 VUs → ровно 1 winner, p95 4–6ms, 0 двойных продаж) + `race-hold.test.ts` 2/2.
