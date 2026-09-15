# Чек-лист изначального ТЗ — CineTicket

Источник требований: изначальное ТЗ, зафиксированное в `docs/CINETICKET_ROADMAP.md`
(разделы 1–11). Каждый пункт ниже — требование ТЗ; статусы сверены с кодом.

Легенда: `[x]` — сделано (дата + где) · `[ ]` — осталось.
Порядок работ agreed: payments (п.1) → storage (п.2) → SMS/OTP (п.3) → тесты (п.4) → остальное из ТЗ.

**Прогресс: 89/89 — всё ТЗ закрыто** 🎉 (обновляется при каждом закрытии пункта)

---

## 1. Архитектура (10 пунктов ТЗ)

- [x] 1. Monorepo `client / server / shared`, общие типы/схемы/прайсинг — было изначально.
- [x] 2. Слои `modules → services → db`, интерфейс `Repositories`, реализации JSON + Prisma — 2026-09-14 (п.2).
- [x] 3a. `PaymentProvider` + фабрика (`mock | yookassa | stripe | paypal`), вебхуки, Circuit Breaker — 2026-09-14 (п.1).
- [x] 3b. `SmsProvider` + фабрика (`mock | generic | smsru | smsc | twilio`) — 2026-09-14 (п.3).
- [x] 4. State-машина `pending → confirmed → cancelled | expired`, переходы только через сервисы — было изначально.
- [x] 5. Saga оплаты + идемпотентный `createIntent` — было изначально.
- [x] 6. Блокировки мест: Redis Lua-holds + SSE-инвалидация (`useSeatStream`) — 2026-09-14 (п.2).
- [x] 7a. `pino` + `X-Request-Id` + `redact` секретов — было изначально.
- [x] 7b. Метрики (latency, 401-rate, payment_failed) и алерты — 2026-09-14 (п.9: реестр без зависимостей `utils/metrics.ts` (counters/gauges/histogram, Prometheus-рендер), `middleware/metrics.ts` (latency по route-шаблонам), `services/alerts.ts` (пороговые правила: payment_failed-rate, 401/мин, HTTP-error-rate, p95-latency, seat-конфликты, SMS-квота, очереди, circuit breaker; кулдауны, POST в `ALERT_WEBHOOK_URL`), `GET /api/metrics|/summary|/alerts` под `METRICS_TOKEN`; тесты `observability.test.ts` 4/4).
- [x] 8. Очереди BullMQ + Redis (SMS, email, PDF) + воркер с ретраями 5×backoff — 2026-09-14 (п.5: `queues/` + `src/worker.ts` + compose; без Redis — inline; вебхуки оставлены синхронными — идемпотентны и быстрые).
- [x] 9a. i18n `ru/en`, `Intl`-даты/валюты — было изначально.
- [x] 9b. URL-префиксы `/ru/ /en/` + `hreflang` — 2026-09-14 (п.9: `lib/localeRouting.ts` + `basename` роутера по локали, rewrite «голого» URL in-place при бутстрапе, `useSeo` держит canonical/hreflang/OG/JSON-LD на клиенте, серверные `alternates` + `x-default` в sitemap, переключатель языка сохраняет путь; E2E-хелперы переведены на locale-prefixed URL).
- [x] 10a. Vitest unit + API-тесты (supertest) — было изначально, расширено 2026-09-14 (п.1–4: +race-hold; п.9: 166 API/unit-тестов сервера; 2026-09-15 `test:pg` прогнан локально против PostgreSQL 17 + Redis: миграции 0001–0005 применились, 168/168 passed — включая 2 BullMQ-теста и гонки hold'ов через Redis-локи).
- [x] 10b. Playwright E2E + k6 load — 2026-09-14 (п.4: 2 спеки + booking-spike.js; п.9: +axe-спек — 3 спека, 4/4 зелёные).

## 2. Схема БД (Prisma)

- [x] Ядро в Postgres: `User / Session / Booking / Payment / WebhookEvent` + миграции — 2026-09-14 (п.2).
- [x] `OtpCode` (argon2-хеш, TTL, попытки, purpose `payment | phone_verify | login`) — 2026-09-14 (п.3).
- [x] Каталог в БД: `City / Cinema / Hall / Movie / Screening / Seat` — 2026-09-14 (п.9: миграция `0004_catalog`, модели в `schema.prisma`, сид каталога (города/кинотеатры/залы 8×12/места с классами/фильмы/сеансы на 14 дней) при старте через `CatalogRepository`, раздача из БД с round-trip id/цен; JSON-адаптер — та же семантика; тесты `catalog-db.test.ts` 4/4, в т.ч. окно брони по часовым поясам кинотеатров).
- [x] `Refund / Ticket / Promocode / BonusTransaction / Referral / Review / AuditLog` — 2026-09-14 (п.9: миграция `0005_tickets_loyalty` (+ `0003_audit_log` ранее), репозитории в обоих адаптерах; Ticket/Refund используются в refund-флоу, Promocode — серверные промокоды, BonusTransaction/Referral — `loyaltyService` (начисление `BONUS_PERCENT` за оплату, welcome/inviter-бонусы, `GET /api/auth/loyalty`, `LoyaltyCard` в /account), Review — `POST/GET /api/movies/:slug/reviews` + `MovieReviews` (рейтинг влияет на `AggregateRating` в JSON-LD)).
- [x] `User.phone` + `phoneVerifiedAt` — 2026-09-14 (п.9: в схеме + миграции, верификация через OTP `phone_verify` (`POST /api/auth/phone/verify` → SMS, `/phone/confirm`), UI `PhoneVerificationCard` в /account; тесты в `auth-flows.test.ts`).

## 3. Дерево проекта

- [x] `services/payments/providers/` (yookassa, stripe, paypal, mock + factory) — 2026-09-14 (п.1).
- [x] `modules/webhooks.ts` — 2026-09-14 (п.1).
- [x] `db/` репозитории (json + prisma) — 2026-09-14 (п.2).
- [x] `server/prisma/` (schema + migrations) — 2026-09-14 (п.2).
- [x] `docker-compose.yml` (postgres + redis + api) — 2026-09-14 (п.2).
- [x] `services/sms/` (smsru, smsc, twilio, generic, mock + factory) — 2026-09-14 (п.3).
- [x] `queues/` (queueService/pipeline/runner) + воркер `src/worker.ts` — 2026-09-14 (п.5).
- [x] `geo/` (ipapi / MaxMind / Sypex, мидлварь `attachRegion`) — 2026-09-14 (п.6: +mock, тотальный resolveRegion, /api/geo + /api/cities).
- [x] `client/e2e/` (Playwright) — 2026-09-14 (п.4: `purchase.spec.ts`, `sms.spec.ts`; п.9: +`a11y.spec.ts` (axe) — 3 спека, 4/4 зелёные).
- [x] `k6/booking-spike.js` — 2026-09-14 (п.4: hot race 1000 VUs + spike, все пороги зелёные).

## 4. Backend

- [x] Вся таблица API (auth, movies, theaters, showtimes, holds, bookings, payments, webhooks, config) — п.1 закрыл webhooks.
- [x] Правила `PaymentProvider` (идемпотентность, подпись до логики, ретраи, CB) — 2026-09-14 (п.1).
- [x] Интерфейс `SmsProvider` + провайдеры — 2026-09-14 (п.3).
- [x] OTP: 6 цифр (`SMS_CODE_LENGTH`) — 2026-09-14 (п.3).
- [x] OTP: TTL 5 мин (`SMS_CODE_TTL_SECONDS`, в `OtpCode`) — 2026-09-14 (п.3).
- [x] OTP: 3 попытки (`SMS_MAX_ATTEMPTS`, в `OtpCode`) — 2026-09-14 (п.3).
- [x] OTP: 5 SMS/час на номер (Redis-счётчики `sms:rl:*`, 429) — 2026-09-14 (п.3).
- [x] Redis-локи + `pg_advisory_xact_lock` на checkout — 2026-09-14 (п.2).

## 5. Frontend

- [x] Каталог, карточка фильма, фильтры, поиск — было изначально.
- [x] Трейлер-модалка — 2026-09-14 (п.9: `TrailerModal.tsx` (YouTube-embed, фокус-трап, Esc), кнопка трейлера на странице фильма, `trailerUrl` в каталоге/БД (seed + TMDB), событие `trailer_open`; тест «exposes trailers» в `catalog-db.test.ts`).
- [x] Кинотеатры: карта (Leaflet), выбор города по IP-гео — 2026-09-14 (п.6: страница /cinemas, пилюли городов, дефолт из /api/geo, DivIcon-пины; п.9: фикс инициализации карты после загрузки городов + хит-зона пинов 28px под WCAG 2.2 target-size).
- [x] Календарь сеансов 14 дней — 2026-09-14 (п.9: `CATALOG_WINDOW_DAYS=14` на сервере (генерация расписания на 14 локальных дней каждого кинотеатра), `ScreeningPicker` — 14-дневная лента: дни без сеансов видны, но disabled; тест окна в `catalog-db.test.ts`).
- [x] Зал: SSE-обновления (`useSeatStream`, поллинг — fallback) — 2026-09-14 (п.2).
- [x] Гостевой checkout + SMS-верификация — 2026-09-14 (п.9: `GuestCheckoutDialog` на странице мест (имя+email, без пароля), `POST /api/auth/guest` — гостевой аккаунт + токен, скоупленный на бронь, `lib/guestSession.ts` (заголовок `X-Guest-Token`), оплата тем же OTP-флоу, `POST /api/auth/guest/claim` — пароль и билеты остаются; тесты `auth-flows.test.ts` 4/4: бронь без аккаунта, отказ захвата чужого аккаунта, claim, подделка токена).
- [x] Виджеты ЮKassa/Stripe вместо raw PAN, Apple/Google Pay — 2026-09-14 (п.9: `CardWidgetForm` + `lib/cardWidget.ts` — YooKassa Checkout.js / Stripe JS, PAN вводится в iframe провайдера, на сервер уходит только токен; `CARD_WIDGET=auto|embedded|yookassa|stripe` + `YOOKASSA_PUBLIC_KEY`/`STRIPE_PUBLISHABLE_KEY`, выбор формы из `/api/config` (`paymentWidget`); кнопки Apple Pay / Google Pay (`walletAvailable` по UA + домену), Stripe `automatic_payment_methods`, YooKassa `payment_token`; без ключей — прежняя RSA-форма).
- [x] Возврат из UI, повторная отправка чека — 2026-09-14 (чек — п.5; возврат — п.7: `POST /refund` → PSP-reversal + `refunded`, legacy /cancel тоже возвращает деньги, email «refund», кнопки MyTickets/Ticket).
- [x] URL `/ru/ /en/`, `hreflang` — 2026-09-14 (п.9: см. 9b — роутер с `basename` по локали, canonical/hreflang/OG через `useSeo` + серверный shell).

## 6. Интеграции

- [x] ЮKassa (МИР/СБП, 3DS через `requires_action`, webhook с API-подтверждением) — 2026-09-14 (п.1).
- [x] Stripe (PaymentIntent, HMAC-вебхуки, 3DS) — 2026-09-14 (п.1).
- [x] PayPal (Orders API, approve-redirect, capture в вебхуке) — 2026-09-14 (п.1).
- [x] PCI-виджеты (Checkout.js / PaymentElement) вместо raw PAN — 2026-09-14 (п.9: см. Frontend «Виджеты» — `CardWidgetForm`, token-only payload на сервер, `payment_token`/`automatic_payment_methods` у провайдеров).
- [x] SMS.ru / SMSC.ru / Twilio провайдеры + rate limit 5/час — 2026-09-14 (п.3, очередь — см. п.8 архитектуры).
- [x] IP-гео (`GEO_PROVIDER`, `attachRegion` → город/кинотеатры/валюта) — 2026-09-14 (п.6: провайдеры mock/ipapi/sypex/maxmind, тотальный resolveRegion + кэш 5 мин, /api/geo + /api/cities + /theaters?city=).
- [x] Email (SMTP/SendGrid: билеты, чеки, magic link) — 2026-09-14 (п.5: провайдеры + шаблоны билет/чек + QR + PDF-чек; п.9: magic link — `POST /api/auth/magic-link` (одноразовая ссылка, TTL `MAGIC_LINK_TTL_MINUTES=15`, не раскрывает наличие аккаунта) + `/magic-link/verify` → полная сессия, UI на LoginPage; тесты `auth-flows.test.ts` 3/3).
- [x] TMDB (постеры/рейтинги с кэшем) — было изначально.

## 7. Безопасность

- [x] База: RSA-PAN, scrypt-пароли, JWT rotate-refresh, rate limiting, Zod, CSP/HSTS, `redact` — было изначально.
- [x] OTP-хеш argon2id (в `OtpCode`, sha256 удалён) — 2026-09-14 (п.3).
- [x] GDPR: `DELETE /api/auth/account` + `GET /api/auth/export` — 2026-09-14 (п.8: экспорт + стирание с каскадом, места освобождаются, страница /account, кука чистится, refresh отзывается).
- [x] Аудит-лог `AuditLog` (register/login/payment/refund) — 2026-09-14 (п.8: +export/delete/webhook; json+prisma + миграция 0003, без PII в meta, включён в GDPR-экспорт; п.9: UTM-атрибуция в `meta.utm` из `X-Utm`/query через requestContext).
- [x] CSRF double-submit для cookie-мутаций — 2026-09-14 (п.8: вместо double-submit — csrfGuard: cookie-мутации требуют X-Requested-With, клиент шлёт всегда; Lax+HttpOnly, тесты 403/404).

## 8. SEO

- [x] Пререндер каталога (vite-ssr / витрина) — 2026-09-14 (п.9: серверный SEO-слой `services/seo.ts` + `modules/seo.ts` — при `SERVE_CLIENT` каждый маршрут отдаётся шеллом с живыми метаданными из каталога: title/description/canonical/OG + JSON-LD + `noscript`-витрина (список фильмов с постерами/рейтингами и ссылками) — краулеры видят контент без JS; SPA-fallback сохранён).
- [x] JSON-LD (`Movie/ScreeningEvent/MovieTheater/Offer/AggregateRating/BreadcrumbList`) — 2026-09-14 (п.9: серверная генерация для шелла + клиентская `lib/seoLd.ts`/`useSeo` для SPA-навигации; все 6 типов + `WebSite/SearchAction` на главной и `VideoObject` для трейлеров; `AggregateRating` из реальных отзывов/рейтингов).
- [x] `sitemap.xml`, `robots.txt`, canonical, OG-теги — 2026-09-14 (п.9: `GET /sitemap.xml` (все маршруты × ru/en + `xhtml:link` hreflang + x-default), `GET /robots.txt` (Disallow приватных маршрутов, Sitemap), canonical/OG в шелле и в `useSeo`; проверено смоуком на собранном билде).
- [x] Чистые URL `/movies/:slug` — было изначально.

## 9. A11y (WCAG 2.2 AA)

- [x] База: aria-label мест, `aria-live`, фокус-стили, клавиатура, тач-цели ≥44px — было изначально.
- [x] `prefers-reduced-motion` в CSS — 2026-09-14 (п.9: `styles/index.css` — `@media (prefers-reduced-motion: reduce)`: scroll-behavior auto, animation/transition ≈0 у всех элементов).
- [x] Аудит axe в CI — 2026-09-14 (п.9: `@axe-core/playwright` + `e2e/a11y.spec.ts` — теги wcag2a/2aa/21a/21aa/22aa, страницы: home, movie, cinemas (Leaflet), login, seat map; запускается в CI job `e2e`; найденные нарушения исправлены: контраст secondary-текста (white/25-45 → 50-60), danger-кнопка (red-600, 4.8:1), хит-зона map-пина 20→28px (target-size)).

## 10. Аналитика

- [x] GA4 + Метрика через GTM — 2026-09-14 (п.9: `AnalyticsBridge` + `lib/analytics.ts` — контейнер GTM и/или прямой gtag/ym из `GET /api/config` (`GTM_ID`/`GA4_ID`/`YM_ID`, без пересборки клиента; пусто — теги не грузятся), `page_view` на каждый SPA-переход).
- [x] События `view_movie … payment_failed`, UTM в `AuditLog.meta` — 2026-09-14 (п.9: весь воронка ТЗ — `view_movie`, `view_showtime` (=view_screening), `view_seat_map`, `select_seat`, `begin_checkout`, `add_payment_info`, `sms_code_sent`, `sms_code_verified`, `purchase`, `payment_failed`, `refund` + `sign_up/login/guest_checkout/magic_link_requested/phone_verified/trailer_open/review_submitted/promo_applied`; UTM: захват на лендинге → sessionStorage → заголовок `X-Utm` на каждый запрос → `requestContext` → `AuditLog.meta.utm`).

## 11. Тесты

- [x] Unit-база (прайсинг, seats, card, localize, countdown) — было изначально.
- [x] Unit: OTP-лимиты + SMS-провайдеры — 2026-09-14 (п.3).
- [x] Unit: провайдеры платежей (mock) — 2026-09-14 (п.1).
- [x] Unit: вебхук-подписи — 2026-09-14 (п.1).
- [x] API: 64 теста (auth/refresh/booking/payment/promo/изоляция/вебхуки/SSE/OTP) — 2026-09-14 (п.1–3).
- [x] API: вебхуки (двойная доставка) — 2026-09-14 (п.1).
- [x] API: `X-Auth-Token` — было изначально.
- [x] API: race-hold (конкурентный захват мест) — 2026-09-14 (п.4: `race-hold.test.ts`, 2/2 в JSON и PG/Redis).
- [x] E2E Playwright `purchase.spec.ts` (+ `sms.spec.ts`) — 2026-09-14 (п.4: регистрация → промо → карта → SMS → QR; resend; CI job `e2e`; п.9: +`a11y.spec.ts`, починены хелперы под locale-префиксы и vite pre-bundle — 4/4 зелёные стабильно).
- [x] Load k6 `booking-spike.js` (1000 VUs, p95 < 500ms, 0 double-book) — 2026-09-14 (п.4: ровно 1 winner/1000, p95 seats 6ms/holds 4ms, 0 ошибок); 2026-09-15 перепроверено на продакшн-стеке Postgres 17 + Redis (k6 v0.57.0): checks 100% (6962/6962), hot_seat_wins=1 из 1000, spike_errors 0%, p95 seats 102ms / holds 88ms, ~216 req/s на 2 vCPU, все пороги зелёные (exit 0).

## 12. Конфиги

- [x] `.env`: `DATABASE_URL`, `REDIS_URL`, `PAYMENTS_PROVIDER`, `YOOKASSA_*/STRIPE_*/PAYPAL_*` — 2026-09-14 (п.1–2).
- [x] `.env`: `SMS_PROVIDER`, `SMS_MAX_PER_HOUR`, `SMSRU_API_ID`, `SMSC_*`, `TWILIO_*` — 2026-09-14 (п.3).
- [x] `.env`: `GTM_ID` (`GEO_PROVIDER` + `GEO_MMDB_PATH` + `GEO_TIMEOUT_MS` — 2026-09-14, п.6; `SMTP_*` + `EMAIL_*` + `SENDGRID_API_KEY` + `QUEUES_DRIVER` — 2026-09-14, п.5; `ARGON2_*` не понадобились — дефолты argon2id в коде) — 2026-09-14 (п.9: в `server/.env.example` задокументированы `GTM_ID`/`GA4_ID`/`YM_ID`, `METRICS_*`/`ALERTS_*`/`ALERT_*`, `MAGIC_LINK_TTL_MINUTES`, `GUEST_TOKEN_TTL_HOURS`, `CATALOG_WINDOW_DAYS`, `BONUS_PERCENT`/`REFERRAL_*`, `CARD_WIDGET` + `YOOKASSA_PUBLIC_KEY`/`STRIPE_PUBLISHABLE_KEY`).

## 13. Самопроверка ТЗ

- [x] Два пользователя / одно место → `409 seat_unavailable` — было изначально, подтверждено на Redis 2026-09-14.
- [x] Вебхук дважды → `200 already_processed` — 2026-09-14 (п.1).
- [x] Лок истёк во время оплаты → `expired`, деньги не списываются — было изначально.
- [x] Покупка вслепую (a11y) — было изначально.
- [x] Потерян `Authorization` → `X-Auth-Token` + cookie — было изначально.
- [x] OTP по ТЗ (6 цифр, TTL 5 мин, 3 попытки, 5 SMS/час) — 2026-09-14 (п.3).
- [x] Нагрузка 1000 броней, p95 < 500ms, 0 двойных продаж — 2026-09-14 (п.4: k6 hot race 1000 VUs → ровно 1 winner, p95 4–6ms, 0 ошибок).

---

## 🏁 Финал

- [x] 🎉 **Всё из изначального ТЗ готово** — 2026-09-14 (п.9 закрыл остатки: метрики+алерты, каталог/loyalty/phone в БД, трейлер, календарь 14 дней, гостевой checkout, PCI-виджеты + Apple/Google Pay, magic link, locale-URL+hreflang, пререндер+JSON-LD+sitemap/robots, reduced-motion, axe в CI, GTM/GA4/Метрика + события + UTM, .env-документация; попутно исправлены регрессии: E2E-хелперы под /en-/ru-префиксы, vite optimizeDeps против reload во время тестов, инициализация Leaflet-карты, контраст и target-size по WCAG 2.2, прод-сборка — копирование сгенерированного Prisma-клиента в dist и поиск client/dist из dist-леяута; итог: typecheck 0, lint 0 ошибок, format ✓, server 166 passed/2 skipped, client 28 passed, E2E 4/4, прод-смоук SERVE_CLIENT ✓; 2026-09-15 дополнительно: `test:pg` на реальных Postgres 17 + Redis — 168/168 passed, prisma migrate deploy применил все 5 миграций).
