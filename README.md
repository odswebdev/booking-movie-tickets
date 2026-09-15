# CineTickets — система бронирования билетов в кино

Полноценный full-stack сервис покупки билетов в кино: выбор фильма → кинотеатра → даты → времени → мест,
бронирование мест с таймером, оплата картой **Мир / Visa / Mastercard / UnionPay** или **PayPal**
с подтверждением по **6-значному коду из SMS**, электронный билет с QR-кодом и история покупок.

Интерфейс — **двуязычный (RU/EN)**: русская версия показывает цены в **рублях** и московские кинотеатры,
английская — в **долларах** и кинотеатры Нью-Йорка. Язык переключается в шапке (кнопка с глобусом).

> **Живое демо (Vercel):** https://booking-movie-tickets-beta.vercel.app — demo-режим: mock-оплата,
> SMS-код показывается прямо на странице (`devCode`), состояние сбрасывается при остывании serverless-инстанса.
>
> English version: [README.en.md](./README.en.md)

---

## Содержание

- [Возможности](#возможности)
- [Стек и структура](#стек-и-структура)
- [Быстрый старт](#быстрый-старт)
- [Скрипты](#скрипты)
- [Переменные окружения](#переменные-окружения)
- [Двуязычность и валюты](#двуязычность-и-валюты)
- [Каталог фильмов: TMDB или встроенный](#каталог-фильмов-tmdb-или-встроенный)
- [Оплата: карты, PayPal и SMS-код](#оплата-карты-paypal-и-sms-код)
- [Безопасность платежных данных](#безопасность-платежных-данных)
- [Скидки, промокоды и бейджи](#скидки-промокоды-и-бейджи)
- [API](#api)
- [Тесты, линтеры, CI](#тесты-линтеры-ci)
- [Деплой](#деплой)

---

## Возможности

**Пользовательский флоу**

- Афиша «Сейчас в кино» с крупными постерами, бейджами «Новинка» и «Акция −N%», блоком рекомендации и ценой «от».
- Страница фильма: локализованные название и описание, рейтинг, длительность, жанры, каскад **кинотеатр → дата → время**
  с количеством свободных мест и ценой от.
- Схема зала 8×12 с классами мест (Standard / Premium / Recliner), легендой, подсказками и доступными aria-лейблами.
- **Бронь на 5 минут**: выбранные места блокируются, идёт обратный отсчёт, при истечении — они освобождаются.
- Регистрация и логин (JWT access + refresh, refresh-токены отзываются на сервере), защищённые роуты,
  возврат к незавершённому выбору после логина.
- Оформление заказа: промокод, детализация цены (подытог, скидка, сервисный сбор, итог), таймер заказа.
- Оплата: выбор способа (карта / PayPal), телефон, **6-значный код из SMS**, 3 попытки, повторная отправка через 30 с.
- Билет с QR-кодом, печать/скачивание PNG, «Мои билеты» (предстоящие / история), возврат более чем за 2 часа до сеанса
  с автоматическим PSP-реверсом и письмом.
- **Гостевая покупка** без регистрации (токен скоупится на бронь, позже аккаунт можно «заклеймить» паролем),
  вход по **magic link** из письма, верификация телефона по SMS.
- Лояльность: бонусы за покупки, списание бонусов, реферальные коды (бонус обоим), отзывы с рейтингом на странице фильма.
- Трейлер-модалка, календарь сеансов на **14 дней**, страница кинотеатров с Leaflet-картой и определением города по IP.

**Продуктовое и техническое**

- RU/EN интерфейс (i18next), рубли для RU, доллары для EN, даты/время/числа по локали.
- Локализованные каталоги кинотеатров (Москва ↔ Нью-Йорк) со своими часовыми поясами.
- Сквозная типизация `shared/` (типы, схемы zod, цены и скидки, схема зала) — клиент и сервер не расходятся.
- Строгий TypeScript, ESLint (type-aware), Prettier, Vitest (unit + компонентные), Playwright E2E + axe-аудит WCAG 2.2 AA, k6 load, GitHub Actions CI.
- Хранилище: zero-config JSON **или** PostgreSQL (Prisma-миграции, advisory-lock) + Redis (holds, SSE pub/sub,
  BullMQ-очереди SMS/email/PDF) — выбор переменными `DATABASE_URL`/`REDIS_URL`.
- Платёжные провайдеры: mock / ЮKassa / Stripe / PayPal (вебхуки с проверкой подписи и идемпотентностью,
  Circuit Breaker), PCI-виджеты Checkout.js / Stripe JS с Apple Pay и Google Pay вместо raw PAN.
- SEO: серверный пререндер шелла (meta/OG/canonical/hreflang + JSON-LD `Movie/ScreeningEvent/Offer/AggregateRating/
  BreadcrumbList` + noscript-витрина), `sitemap.xml`, `robots.txt`; URL-префиксы локалей `/en/…` и `/ru/…`.
- Наблюдаемость и аналитика: Prometheus-метрики (`/api/metrics`) с пороговыми алертами (webhook + кулдауны),
  GTM/GA4/Яндекс.Метрика с полным воронкой событий и UTM-атрибуцией в аудит-логе.
- JSON-датастор с атомарной записью, структурированное логирование (pino) с маскированием телефонов,
  rate limiting, request-id, CSRF-guard, GDPR экспорт/удаление аккаунта, аудит-лог,
  централизованная обработка ошибок, graceful shutdown.

---

## Стек и структура

```
movie-tickets/
├── shared/          # общий код: типы, zod-схемы, деньги/скидки, схема зала
├── server/          # Express + TypeScript API (tsx в dev, tsc в prod)
│   └── src/
│       ├── config/       # env (zod-валидация)
│       ├── db/           # JSON-хранилище (атомарная запись, дедуп)
│       ├── middleware/   # auth, validate, rate limit, error handler
│       ├── modules/      # роуты: health, auth, config, movies, theaters, showtimes, bookings, payments, promotions
│       ├── services/     # catalog, tmdb, booking, payment, promotions, sms, crypto, fx, auth
│       └── utils/        # ошибки, логирование, время, crypto, id
├── client/          # React 19 + TypeScript + Vite + Tailwind 4
│   └── src/
│       ├── api/          # http-клиент, эндпоинты, query-ключи
│       ├── components/   # ui, cinema (MovieCard, SeatMap, CardForm, PriceSummary…), layout
│       ├── context/      # auth, booking flow, toasts
│       ├── i18n/         # i18next + locales/en.json, locales/ru.json + AppConfigProvider
│       ├── lib/          # localize, money, phone, cardCrypto (RSA-OAEP), seats, downloadTicket
│       └── pages/        # Home, Movie, Seats, Checkout, Payment, Success, Ticket, MyTickets, Auth, 404
└── .github/workflows/ci.yml
```

**Ключевые зависимости:** express 4, zod, pino, react 19, react-router 6, @tanstack/react-query 5,
react-hook-form + zod, i18next/react-i18next, framer-motion, lucide-react, vitest + @testing-library, tailwindcss 4.

---

## Быстрый старт

```bash
git clone <repo> && cd movie-tickets
npm install

# терминал 1 — API на http://localhost:4000
npm run dev:api

# терминал 2 — клиент на http://localhost:5173 (проксирует /api на 4000)
npm run dev:web
```

Одновременно всё сразу: `npm run dev`.

Одним процессом (API раздаёт собранный клиент):

```bash
cd client && VITE_BASE=/ npm run build && cd ../server
SERVE_CLIENT=true NODE_ENV=development JWT_SECRET=$(openssl rand -base64 48) npm run start
# → http://localhost:4000
```

Демо-данные: 6 фильмов, 6 кинотеатров, 14 дней расписания (`CATALOG_WINDOW_DAYS`), часть мест «продана» детерминированно.

---

## Скрипты

| Команда                | Что делает                                               |
| ---------------------- | -------------------------------------------------------- |
| `npm run dev`          | API + клиент в watch-режиме                              |
| `npm run build`        | Сборка клиента и сервера                                 |
| `npm start`            | Продакшн-запуск API (по умолчанию раздаёт `client/dist`) |
| `npm run typecheck`    | `tsc --noEmit` для клиента и сервера                     |
| `npm run lint`         | ESLint (type-aware) для клиента и сервера                |
| `npm run test`         | Vitest: сервер (166 API/unit-тестов) + клиент (28)       |
| `npm run test:pg -w @movie-tickets/server` | Те же тесты против Postgres + Redis    |
| `npm run test:e2e -w @movie-tickets/client` | Playwright: purchase + sms + a11y (axe) |
| `npm run worker -w @movie-tickets/server` | BullMQ-воркер очередей sms/email/pdf   |
| `npm run format`       | Prettier --write                                         |
| `npm run format:check` | Проверка форматирования (то же, что в CI)                |

С любым скриптом можно работать через `-w @movie-tickets/server` / `-w @movie-tickets/client`.

---

## Переменные окружения

Готовые шаблоны: [`server/.env.example`](./server/.env.example),
[`client/.env.example`](./client/.env.example), [`client/.env.production.example`](./client/.env.production.example).

Обязательные в проде:

| Переменная    | Назначение                                                               |
| ------------- | ------------------------------------------------------------------------ |
| `JWT_SECRET`  | Подпись access/refresh токенов (`openssl rand -base64 48`)               |
| `CORS_ORIGIN` | Список origins через запятую; `*` только в dev                           |
| `NODE_ENV`    | `production` включает HSTS, строгие cookie, скрывает dev-подсказки кодов |

Опциональные (см. подробности ниже):

| Переменная                                                                             | Назначение                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------- |
| `TMDB_API_KEY`, `TMDB_LANGUAGE`, `TMDB_REGION`, `TMDB_IMAGE_BASE`, `TMDB_CACHE_TTL_MS` | Каталог фильмов из TMDB                       |
| `SMS_PROVIDER`, `SMSRU_API_ID`/`SMSC_*`/`TWILIO_*`, `SMS_MAX_PER_HOUR` (legacy: `SMS_PROVIDER_URL`+`SMS_PROVIDER_TOKEN`) | Отправка 6-значного кода: smsru/smsc/twilio/generic/mock, 5 SMS/час на номер |
| `DATABASE_URL`, `REDIS_URL`, `QUEUES_DRIVER`                                           | Postgres (Prisma) / Redis (holds, SSE, BullMQ) / драйвер очередей |
| `PAYMENTS_PROVIDER`, `YOOKASSA_*`, `STRIPE_*`, `PAYPAL_*`, `CARD_WIDGET`, `*_PUBLIC_KEY`/`*_PUBLISHABLE_KEY` | Платёжные провайдеры и PCI-виджеты            |
| `EMAIL_PROVIDER`, `SMTP_*`, `SENDGRID_API_KEY`, `MAGIC_LINK_TTL_MINUTES`               | Письма (билеты/чеки) и вход по magic link     |
| `GEO_PROVIDER`, `CATALOG_WINDOW_DAYS`, `BONUS_PERCENT`, `REFERRAL_*`                   | IP-гео, окно расписания (14 дней), лояльность |
| `GTM_ID`, `GA4_ID`, `YM_ID`, `METRICS_*`, `ALERTS_ENABLED`, `ALERT_*`                  | Аналитика (GA4/Метрика через GTM), метрики и алерты |
| `FX_RATES`                                                                             | Курсы от базовой валюты (USD): `RUB:90,USD:1` |
| `PROMO_CODES`                                                                          | Промокоды: `WELCOME10:10,CINEMA20:20`         |
| `SERVE_CLIENT`, `DATA_DIR`, `LOG_LEVEL`, `TRUST_PROXY`, `*_RATE_LIMIT_*`               | Прочее (см. `.env.example`)                   |

---

## Двуязычность и валюты

- Язык выбирается в шапке (dropdown RU/EN) и сохраняется в `localStorage` (`cinetickets.locale`);
  при первом визите определяется язык браузера. `<html lang>` синхронизируется автоматически.
- **EN → USD**, **RU → RUB** (курс задаётся `FX_RATES`, по умолчанию 1 USD = 90 RUB).
  Все суммы хранятся в центах базовой валюты (USD), конвертация — на клиенте для отображения
  и на сервере для расчёта: клиент и сервер всегда показывают одну цену (`shared/pricing.ts`).
- Переведены: интерфейс, названия и описания фильмов, кинотеатры и адреса, форматы дат/времени/длительности,
  сообщения валидации и ошибок API, письма/билет (PDF не нужен — PNG-билет тоже локализован).
- Расписание считается в часовом поясе города: Нью-Йорк (`America/New_York`) и Москва (`Europe/Moscow`),
  поэтому «18:30» — это 18:30 на часах соответствующего кинотеатра.

**Сессии**

- access-токен живёт `JWT_ACCESS_TTL` (по умолчанию `15m`; понимает `30s`, `15m`, `1h`, `7d`),
  refresh-токен — `JWT_REFRESH_TTL_DAYS` и ротируется при каждом обновлении.
- Если уже ротированный refresh-токен прилетает снова в течение `REFRESH_REUSE_GRACE_MS` (60 с),
  сервер считает это гонкой двух вкладок, а не кражей: просто выпускает новую пару токенов.
  По истечении допуска отзываются сессии, существовавшие на момент ротации (и её наследник), но **свежий
  логин всегда выживает** — аккаунт нельзя заблокировать навсегда.
- Клиент при любой 401-й после неудачного рефреша сбрасывает сессию и уводит на `/login?from=…`,
  откуда после входа пользователь возвращается ровно на тот шаг, на котором остановился
  (вместо тупика «Оформление недоступно»).

Добавить язык: создать `client/src/i18n/locales/<code>.json`, добавить код в `SUPPORTED_LOCALES`
и `LOCALE_LABELS`, в `shared/pricing.ts` — валюту в `CURRENCY_BY_LOCALE` и `FX_RATES`,
в `shared/cinema.ts` — часовой пояс, в каталоге сервера — кинотеатры с `locale`.

---

## Каталог фильмов: TMDB или встроенный

**Да, подключить внешний API можно — и он уже подключён.** Используется
[The Movie Database](https://www.themoviedb.org/documentation/api):

```bash
# server/.env
TMDB_API_KEY=ваш_ключ
TMDB_LANGUAGE=en-US
TMDB_REGION=US
TMDB_IMAGE_BASE=https://image.tmdb.org/t/p
TMDB_CACHE_TTL_MS=21600000   # 6 часов
```

Что происходит с ключом:

1. На старте сервер запрашивает `/movie/now_playing` для **каждого** языка (`en-US`, `ru-RU`),
   `/genre/movie/list` и детали фильмов (хронометраж).
2. Постер, дата выхода, рейтинг, жанры, название и описание берутся из TMDB — в том числе на русском.
3. Результат кэшируется в памяти на `TMDB_CACHE_TTL_MS`, повторные запросы не тратят квоту.
4. Расписание генерируется поверх полученных фильмов — кинотеатры, залы, время и цены остаются нашими.

Без ключа (или если TMDB недоступен/вернул 401) приложение **молча падает на встроенный каталог** из 6 фильмов
с постерами и русскими переводами — сервис всегда поднимается. Источник каталога виден в `GET /api/config`
(`catalogSource: "tmdb" | "local"`).

---

## Оплата: карты, PayPal и SMS-код

1. **Способ оплаты** — банковская карта (Мир, Visa, Mastercard, Amex, UnionPay) или PayPal.
   Бренд определяется по BIN: `2200–2204` → Мир, `4…` → Visa, `51–55`/`2221–2720` → Mastercard, `62…` → UnionPay.
2. **Телефон** — маска по стране (`+7 (916) 123-45-67`, `+1 (202) 555-0123`), номер уходит на сервер в E.164.
3. **Карта шифруется в браузере** (см. ниже) и отправляется в `POST /api/payments/intents`.
4. Сервер проверяет Luhn и срок действия, выпускает платёжное намерение, генерирует **6-значный код**
   и отправляет его по SMS через настроенный шлюз.
5. Клиент показывает 6 отдельных полей для цифр: 3 попытки, обратный отсчёт 5 минут, повторная отправка через 30 с.
6. `POST /api/payments/:id/verify` с верным кодом подтверждает бронь, места становятся «проданными»,
   появляется билет с QR-кодом.

**SMS-шлюз** — любой HTTP-провайдер. Сервер отправляет `POST { "to": "+7…", "text": "…", "from": "…" }`
и, если задан токен, заголовок `Authorization: Bearer …`:

```bash
# Twilio
SMS_PROVIDER_URL=https://api.twilio.com/2010-04-01/Accounts/<SID>/Messages.json
SMS_PROVIDER_TOKEN=<AUTH_TOKEN>          # basic-auth вместо bearer — поменяйте 1 строку в smsService.ts

# SMS.ru / любой совместимый
SMS_PROVIDER_URL=https://sms.ru/sms/send?api_id=<KEY>&json=1
```

Без `SMS_PROVIDER_URL` (только вне продакшена) код пишется в лог сервера и возвращается в ответе
как `devCode` — демо-режим для локальной разработки. В `NODE_ENV=production` dev-поля недоступны,
а при отсутствии шлюза платёж завершается ошибкой «код не отправлен».

Тестовые карты: `4242 4242 4242 4242` (Visa, успех), `2200 0000 0000 0004` (Мир, успех),
`4000 0000 0000 0002` (отказ), PayPal с email `decline@...` (отказ).

---

## Безопасность платежных данных

- **Шифрование на клиенте.** Данные карты (номер, имя, срок, CVC) шифруются в браузере алгоритмом
  **RSA-OAEP (SHA-256)** публичным ключом API (`GET /api/config/payment-key`). По сети уходит только
  base64-шифротекст; требуется HTTPS (или `localhost`) — иначе `crypto.subtle` недоступен и форма
  честно предупреждает пользователя.
- **Расшифровка только в памяти.** Сервер расшифровывает payload приватным ключом, проверяет Luhn и срок,
  сохраняет **только бренд и последние 4 цифры**, затем забывает сам payload. Ключ генерируется при старте
  и живёт только в памяти процесса.
- **Ничего лишнего в хранилище и логах.** Полный номер карты не пишется ни в `db.json`, ни в логи.
  Телефон хранится и показывается **маскированным** (`+7 *** ***-45-67`); в логах — `+7***-**-4567`.
  Пароли — scrypt-хеши с солью; токены в ответах не логируются (в логах `authorization: [redacted]`).
- **Маскирование в UI.** Номер карты скрывается, как только поле теряет фокус (`•••• •••• •••• 4242`),
  CVC всегда `type="password"` с переключателем «показать», SMS-код — 6 отдельных боксов
  с `autocomplete="one-time-code"`.
- **Транспорт.** HSTS включается в проде, helmet с CSP (постерам TMDB разрешён `https://image.tmdb.org`),
  CORS по allow-list, rate limit отдельно на auth и платежи.
- **Целостность цены.** Клиент считает сумму только для предпросмотра; сервер пересчитывает
  `computeQuote()` и игнорирует любые «цены» из запроса.

---

## Скидки, промокоды и бейджи

- **Промокоды** задаются в `PROMO_CODES` (`WELCOME10:10,CINEMA20:20,STUDENT15:15`) и проверяются
  `POST /api/promotions/validate`; применяются к ещё не оплаченной брони
  (`POST /api/bookings/:id/promo`, удаление — `DELETE`), сумма пересчитывается на сервере.
- **Автоматическая скидка за количество**: 4+ билетов → 10 %, 6+ → 15 %.
- **Акция фильма** (`discountPercent`) — скидка на конкретный фильм, задаётся каталогом.
- Скидки **не суммируются** — применяется лучшее предложение.
- Сервисный сбор 6 % начисляется на сумму **после** скидки.
- Бейджи: «Новинка» (релиз в последние 45 дней), «Акция −N%» (есть скидка на фильм), «Билетов нет»
  и количество оставшихся мест — на афише, странице фильма и в сеансах.

---

## API

Базовый путь — `/api`. Ошибки — в формате
`{ "error": { "code": "seat_unavailable", "message": "…", "details": … } }`.

| Метод    | Путь                                     | Назначение                                               |
| -------- | ---------------------------------------- | -------------------------------------------------------- |
| `GET`    | `/health`, `/health/ready`               | Liveness / readiness                                     |
| `GET`    | `/config`                                | Локали, валюты, курсы, способы оплаты, источник каталога |
| `GET`    | `/config/payment-key`                    | Публичный RSA-OAEP ключ для шифрования карты             |
| `POST`   | `/auth/register` `/auth/login`           | Регистрация / вход (access + refresh, реферальный код)   |
| `POST`   | `/auth/refresh` `/auth/logout`           | Обновление / отзыв сессии                                |
| `GET`    | `/auth/me`                               | Текущий пользователь                                     |
| `POST`   | `/auth/guest` `/auth/guest/claim`        | Гостевая бронь (токен на заказ) / клейм в аккаунт        |
| `POST`   | `/auth/magic-link` `/auth/magic-link/verify` | Вход по ссылке из письма (одноразовая, 15 мин)       |
| `POST`   | `/auth/phone/verify` `/auth/phone/confirm` | Верификация телефона по SMS-коду                       |
| `GET`    | `/auth/loyalty`                          | Бонусный баланс, история, реферальный код                |
| `GET`    | `/auth/export` · `DELETE /auth/account`  | GDPR: экспорт данных / удаление аккаунта                 |
| `GET`    | `/movies?locale=en\|ru`                  | Афиша (переводы, число кинотеатров и сеансов)            |
| `GET`    | `/movies/:slug?locale=`                  | Фильм + кинотеатры + даты (14 дней) + времена + цены     |
| `GET/POST` | `/movies/:slug/reviews`                | Отзывы: список с агрегатом / добавить (нужен билет)      |
| `GET`    | `/theaters?locale=`                      | Кинотеатры выбранного города                             |
| `GET`    | `/geo` `/cities`                         | Регион по IP (город, валюта) / список городов            |
| `GET`    | `/showtimes/:id`                         | Сеанс + занятость (и скидка фильма для предпросмотра)    |
| `GET`    | `/showtimes/:id/seats`                   | Схема зала                                               |
| `POST`   | `/showtimes/:id/holds`                   | Бронь мест на 5 минут (`X-Hold-Token`)                   |
| `DELETE` | `/showtimes/:id/holds`                   | Снять бронь                                              |
| `GET`    | `/bookings?scope=upcoming\|history\|all` | Список броней                                            |
| `POST`   | `/bookings`                              | Создать бронь (`showtimeId`, `seatIds`, `promoCode`)     |
| `GET`    | `/bookings/:id`                          | Билет                                                    |
| `POST`   | `/bookings/:id/promo` `DELETE`           | Применить / убрать промокод                              |
| `POST`   | `/bookings/:id/refund`                   | Возврат (PSP-реверс + письмо; не позднее чем за 2 часа)  |
| `POST`   | `/bookings/:id/cancel`                   | Отмена (legacy — тоже возвращает деньги)                 |
| `POST`   | `/bookings/:id/receipt`                  | Повторная отправка чека на email                         |
| `POST`   | `/webhooks/:provider`                    | Вебхуки ЮKassa/Stripe/PayPal (подпись + идемпотентность) |
| `GET`    | `/metrics` `/metrics/summary` `/metrics/alerts` | Prometheus-метрики и сработавшие алерты (`METRICS_TOKEN`) |
| `GET`    | `/sitemap.xml` `/robots.txt`             | SEO-файлы (hreflang-ссылки, Disallow приватных маршрутов)|
| `GET`    | `/promotions`                            | Список активных промокодов                               |
| `POST`   | `/promotions/validate`                   | Проверить код и получить процент                         |
| `POST`   | `/payments/intents`                      | Создать платёж (зашифрованная карта / PayPal + телефон)  |
| `GET`    | `/payments/:id`                          | Статус платежа                                           |
| `POST`   | `/payments/:id/verify`                   | Подтвердить 6-значный код → билет                        |
| `POST`   | `/payments/:id/resend`                   | Отправить код повторно                                   |

---

## Тесты, линтеры, CI

```bash
npm run test          # 166 (API/unit: auth, guest, magic link, phone, booking, payment,
                      #  refund, loyalty, catalog-db, observability, OTP, вебхуки, SSE,
                      #  race-hold; 2 bullmq-теста скипаются без Redis) + 28 (клиент)
npm run lint          # ESLint (type-aware): 0 ошибок
npm run typecheck     # tsc --noEmit, strict
npm run format:check  # Prettier
```

Покрыто тестами: money/локализация, телефоны и карты (Luhn, бренды, маски), таймер брони
(регрессия «старый 0»), схема зала, весь флоу API (регистрация → бронь → оплата → билеты → отмена),
промокоды и скидки, Mir/PayPal, отклонение незашифрованной карты.

E2E (Playwright, Chromium, CI job `e2e`) — 3 спека: `purchase` (регистрация → места → промокод →
карта → SMS-код → билет с QR), `sms` (неверный код → resend → покупка), `a11y` (axe-core: home, movie,
cinemas, login, seat map — WCAG 2.2 AA, 0 нарушений).

Нагрузка (k6, `k6/booking-spike.js`): hot race 1000 VUs на одно место — ровно 1 победитель,
0 двойных продаж, p95 4–6 мс; `BASE_URL=http://localhost:4001 k6 run k6/booking-spike.js`.

CI (`.github/workflows/ci.yml`): `npm ci` → Prettier → typecheck → ESLint → тесты → сборка клиента.

---

## Деплой

**Одним процессом (Render, Fly, Railway, VPS):**

```bash
npm ci
cd client && VITE_BASE=/ npm run build && cd ..
npm run build -w @movie-tickets/server
NODE_ENV=production JWT_SECRET=... SERVE_CLIENT=true CORS_ORIGIN=https://your-domain npm start
```

**Раздельно:** отдайте `client/dist` статикой (Nginx/Netlify/Vercel) и проксируйте `/api` на сервер,
задав `VITE_API_URL`. Для GitHub Pages используйте `VITE_BASE=/movie-tickets/` (значение по умолчанию
для прод-сборки) — SPA-фолбэк обеспечивает `client/public/404.html`.

**Продакшн-чеклист:** задать `JWT_SECRET`, `CORS_ORIGIN`, `NODE_ENV=production`, `APP_PUBLIC_URL`;
настроить SMS-провайдер (`SMS_PROVIDER=smsru|smsc|twilio` + ключи — в production `mock` запрещён) и
email (`EMAIL_PROVIDER`/`SMTP_*` или `SENDGRID_API_KEY`); при желании — `TMDB_API_KEY`, `PROMO_CODES`,
`GTM_ID`/`GA4_ID`/`YM_ID`, `ALERT_WEBHOOK_URL` и `METRICS_TOKEN`; терминировать TLS (без HTTPS браузер
не даст `crypto.subtle`, а виджеты PSP не заработают).

Хранилище переключается переменными, а не правкой кода: `DATABASE_URL` — Postgres через Prisma
(`npm run prisma:migrate -w @movie-tickets/server`, в Docker миграции применяются на старте),
`REDIS_URL` — локи мест, SSE pub/sub и очереди BullMQ; обе падают в zero-config режим независимо
(Postgres недоступен → JSON, Redis недоступен → in-memory). `docker compose up --build` поднимает
`postgres:17 + redis:7 + api + worker` целиком.

---

## Лицензия

MIT. Демонстрационный проект: реального процессинга нет, деньги не списываются.
Данные о фильмах (при наличии ключа) — The Movie Database: этот продукт использует API TMDB,
но не одобрен и не сертифицирован компанией TMDB.
