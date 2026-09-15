import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestApp, teardownTestApp } from "./setup.js";
import request from "supertest";
import type { Express } from "express";
import type { AuthSession, Booking, Movie, PaymentIntent, SeatMap, User } from "../../shared/types.js";

let app: Express;
let tempDir: string;

interface ScreeningResponse {
  movie: Movie;
  screenings: Array<{
    theater: { id: string; name: string };
    days: Array<{ date: string; times: Array<{ showtimeId: string; time: string; seatsLeft: number }> }>;
  }>;
}

beforeAll(async () => {
  const ctx = await setupTestApp("movie-tickets-test-");
  app = ctx.app;
  tempDir = ctx.tempDir;
});

afterAll(async () => {
  await teardownTestApp(tempDir);
});

const TEST_CARD = { number: "4242 4242 4242 4242", name: "Ada Lovelace", expiry: "12/30", cvc: "123" };
const MIR_CARD = { number: "2200 0000 0000 0004", name: "Ada Lovelace", expiry: "12/30", cvc: "123" };
const TEST_PHONE = "+12025550123";

/** Encrypts the card exactly the way the browser does (RSA-OAEP + SHA-256). */
async function encryptedCard(card: typeof TEST_CARD) {
  const { getPaymentKeyPair, encryptLikeBrowser } = await import("../src/services/cryptoService.js");
  const { keyId, publicKey } = getPaymentKeyPair();
  return { keyId, encrypted: encryptLikeBrowser(JSON.stringify(card), publicKey) };
}

async function signUp(email: string, name = "Test User"): Promise<AuthSession> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name, email, password: "Str0ngPassw0rd", confirmPassword: "Str0ngPassw0rd" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as AuthSession;
}

describe("health", () => {
  it("reports readiness", async () => {
    const res = await request(app).get("/api/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.showtimes).toBeGreaterThan(0);
  });

  it("returns JSON (not the SPA) for unknown API routes", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("auth", () => {
  it("registers, returns tokens and exposes the profile", async () => {
    const session = await signUp("ada@example.com", "Ada");
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();

    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${session.accessToken}`);
    expect(me.status).toBe(200);
    expect((me.body as { user: User }).user.email).toBe("ada@example.com");
  });

  it("rejects a weak password with field level details", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Bo", email: "bo@example.com", password: "password", confirmPassword: "password" });
    expect(res.status).toBe(422);
    const fields = (res.body.error.details as Array<{ field: string }>).map((d) => d.field);
    expect(fields).toContain("password");
  });

  it("rejects duplicate emails", async () => {
    await signUp("dupe@example.com");
    const res = await request(app).post("/api/auth/register").send({
      name: "Dup",
      email: "dupe@example.com",
      password: "Str0ngPassw0rd",
      confirmPassword: "Str0ngPassw0rd",
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
  });

  it("rejects a bad password on login", async () => {
    await signUp("grace@example.com");
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "grace@example.com", password: "WrongPassword1" });
    expect(res.status).toBe(401);
  });

  it("rotates refresh tokens and tolerates a replay inside the grace window", async () => {
    const session = await signUp("rotate@example.com");
    const refreshed = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: session.refreshToken });
    expect(refreshed.status).toBe(200);
    expect((refreshed.body as AuthSession).refreshToken).not.toBe(session.refreshToken);

    // A second tab replaying the pre-rotation token is a race, not a theft:
    // it must succeed so the user is never locked out of their own account.
    // (The theft path — replay after the grace window — is covered in
    // tests/auth-reuse.test.ts.)
    const replay = await request(app).post("/api/auth/refresh").send({ refreshToken: session.refreshToken });
    expect(replay.status).toBe(200);
    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${(replay.body as AuthSession).accessToken}`);
    expect(me.status).toBe(200);

    // An unknown token is still refused outright.
    const unknown = await request(app).post("/api/auth/refresh").send({ refreshToken: "not-a-real-token" });
    expect(unknown.status).toBe(401);
  });

  it("protects booking routes", async () => {
    const res = await request(app).get("/api/bookings");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("accepts the access token via the X-Auth-Token fallback header", async () => {
    // Regression test: some tunnels/CDNs strip `Authorization` (and cookies)
    // from requests. The client duplicates the token into `X-Auth-Token`,
    // which must authenticate on its own.
    const session = await signUp("fallback@example.com");
    const viaFallback = await request(app).get("/api/auth/me").set("X-Auth-Token", session.accessToken);
    expect(viaFallback.status, JSON.stringify(viaFallback.body)).toBe(200);
    expect((viaFallback.body as { user: User }).user.email).toBe("fallback@example.com");

    const bookings = await request(app).get("/api/bookings").set("X-Auth-Token", session.accessToken);
    expect(bookings.status).toBe(200);
  });

  it("accepts the mirrored session cookie without any auth header", async () => {
    const session = await signUp("cookie@example.com");
    const viaCookie = await request(app)
      .get("/api/auth/me")
      .set("Cookie", `ct_session=${session.accessToken}`);
    expect(viaCookie.status, JSON.stringify(viaCookie.body)).toBe(200);
    expect((viaCookie.body as { user: User }).user.email).toBe("cookie@example.com");
  });

  it("rejects a forged X-Auth-Token", async () => {
    const res = await request(app).get("/api/auth/me").set("X-Auth-Token", "forged-token");
    expect(res.status).toBe(401);
  });
});

describe("catalog", () => {
  it("lists movies and guarantees future showtimes only", async () => {
    const res = await request(app).get("/api/movies");
    expect(res.status).toBe(200);
    const items = (
      res.body as { items: Array<Movie & { showtimesCount: number; nextShowtimeAt: string | null }> }
    ).items;
    expect(items.length).toBeGreaterThan(0);
    for (const movie of items) {
      expect(movie.showtimesCount).toBeGreaterThan(0);
      expect(new Date(movie.nextShowtimeAt!).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("returns screenings grouped by theatre, day and time", async () => {
    const res = await request(app).get("/api/movies/dune-part-two");
    expect(res.status).toBe(200);
    const body = res.body as ScreeningResponse;
    expect(body.movie.slug).toBe("dune-part-two");
    expect(body.screenings.length).toBeGreaterThan(0);
    expect(body.screenings[0]!.days[0]!.times.length).toBeGreaterThan(0);
  });

  it("404s unknown movies", async () => {
    const res = await request(app).get("/api/movies/not-a-movie");
    expect(res.status).toBe(404);
  });
});

describe("booking + payment flow", () => {
  it("books seats, pays and appears in upcoming tickets", async () => {
    const session = await signUp("buyer@example.com", "Buyer");
    const auth = `Bearer ${session.accessToken}`;

    const screening = (await request(app).get("/api/movies/furiosa")).body as ScreeningResponse;
    // Pick the furthest date so the cancellation window is comfortably open.
    const lastDay = screening.screenings[0]!.days.at(-1)!;
    const showtimeId = lastDay.times[0]!.showtimeId;

    const seatsRes = await request(app).get(`/api/showtimes/${showtimeId}/seats`);
    expect(seatsRes.status).toBe(200);
    const seatMap = seatsRes.body as SeatMap;
    expect(seatMap.capacity).toBe(96);
    const free = seatMap.seats.filter((seat) => seat.status === "available").slice(0, 2);
    expect(free).toHaveLength(2);

    const hold = await request(app)
      .post(`/api/showtimes/${showtimeId}/holds`)
      .send({ seatIds: free.map((seat) => seat.id) });
    expect(hold.status).toBe(200);
    const holdToken = (hold.body as { holdToken: string }).holdToken;

    // Those seats are now held for everybody else.
    const other = await signUp("other@example.com", "Other");
    const conflict = await request(app)
      .post(`/api/showtimes/${showtimeId}/holds`)
      .set("Authorization", `Bearer ${other.accessToken}`)
      .set("X-Hold-Token", "someone-else")
      .send({ seatIds: free.map((seat) => seat.id) });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("seat_unavailable");

    const bookingRes = await request(app)
      .post("/api/bookings")
      .set("Authorization", auth)
      .send({ showtimeId, seatIds: free.map((seat) => seat.id), holdToken });
    expect(bookingRes.status, JSON.stringify(bookingRes.body)).toBe(201);
    const booking = (bookingRes.body as { booking: Booking }).booking;

    const expectedSubtotal = free.reduce((sum, seat) => sum + seat.priceCents, 0);
    const discounted = expectedSubtotal - booking.quote.discountCents;
    expect(booking.quote.subtotalCents).toBe(expectedSubtotal);
    expect(booking.quote.serviceFeeCents).toBe(Math.round(discounted * 0.06));
    expect(booking.quote.totalCents).toBe(discounted + Math.round(discounted * 0.06));
    expect(booking.status).toBe("pending");
    expect(booking.seats).toHaveLength(2);

    const intentRes = await request(app)
      .post("/api/payments/intents")
      .set("Authorization", auth)
      .send({
        bookingId: booking.id,
        method: "card",
        phone: TEST_PHONE,
        card: await encryptedCard(TEST_CARD),
      });
    expect(intentRes.status, JSON.stringify(intentRes.body)).toBe(201);
    const intent = (intentRes.body as { payment: PaymentIntent }).payment;
    expect(intent.status).toBe("requires_code");
    expect(intent.method).toBe("card");
    expect(intent.cardBrand).toBe("visa");
    expect(intent.cardLast4).toBe("4242");
    expect(intent.codeLength).toBe(6);
    expect(intent.phoneMasked).toBe("+1 *** ***-01-23");
    expect(intent.amountCents).toBe(booking.quote.totalCents);
    expect(intent.devCode).toMatch(/^\d{6}$/);

    const badCode = await request(app)
      .post(`/api/payments/${intent.id}/verify`)
      .set("Authorization", auth)
      .send({ code: "000000" });
    expect(badCode.status).toBe(402);
    expect((badCode.body.error.details as { payment: PaymentIntent }).payment.attemptsLeft).toBe(2);

    const goodCode = await request(app)
      .post(`/api/payments/${intent.id}/verify`)
      .set("Authorization", auth)
      .send({ code: intent.devCode! });
    expect(goodCode.status, JSON.stringify(goodCode.body)).toBe(200);
    const paid = (goodCode.body as { booking: Booking }).booking;
    expect(paid.status).toBe("confirmed");
    expect(paid.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Seats are now sold to everybody else.
    const afterPay = await request(app).get(`/api/showtimes/${showtimeId}/seats`);
    const statuses = new Map((afterPay.body as SeatMap).seats.map((seat) => [seat.id, seat.status]));
    for (const seat of free) expect(statuses.get(seat.id)).toBe("sold");

    const upcoming = await request(app).get("/api/bookings?scope=upcoming").set("Authorization", auth);
    expect(upcoming.status).toBe(200);
    expect((upcoming.body as { items: Booking[] }).items.map((item) => item.id)).toContain(paid.id);

    // History is empty because the show is still in the future.
    const history = await request(app).get("/api/bookings?scope=history").set("Authorization", auth);
    expect((history.body as { items: Booking[] }).items).toHaveLength(0);

    const cancel = await request(app).post(`/api/bookings/${paid.id}/cancel`).set("Authorization", auth);
    expect(cancel.status).toBe(200);
    expect((cancel.body as { booking: Booking }).booking.status).toBe("cancelled");

    const afterCancel = await request(app).get(`/api/showtimes/${showtimeId}/seats`);
    const statuses2 = new Map((afterCancel.body as SeatMap).seats.map((seat) => [seat.id, seat.status]));
    for (const seat of free) expect(statuses2.get(seat.id)).not.toBe("sold");
  }, 30_000);

  it("detects Mir cards and PayPal accounts", async () => {
    const session = await signUp("mir@example.com", "Mir User");
    const auth = `Bearer ${session.accessToken}`;
    const screening = (await request(app).get("/api/movies/if?locale=en")).body as ScreeningResponse;
    const showtimeId = screening.screenings[0]!.days[0]!.times[0]!.showtimeId;
    const seats = (await request(app).get(`/api/showtimes/${showtimeId}/seats`)).body as SeatMap;
    const ids = seats.seats
      .filter((seat) => seat.status === "available")
      .slice(0, 1)
      .map((seat) => seat.id);

    const booking = await request(app)
      .post("/api/bookings")
      .set("Authorization", auth)
      .send({ showtimeId, seatIds: ids });
    expect(booking.status).toBe(201);

    const mir = await request(app)
      .post("/api/payments/intents")
      .set("Authorization", auth)
      .send({
        bookingId: (booking.body as { booking: Booking }).booking.id,
        method: "card",
        phone: "+79161234567",
        card: await encryptedCard(MIR_CARD),
      });
    expect(mir.status).toBe(201);
    expect((mir.body as { payment: PaymentIntent }).payment.cardBrand).toBe("mir");

    const created = await request(app)
      .post("/api/bookings")
      .set("Authorization", auth)
      .send({ showtimeId, seatIds: ids });
    const paypal = await request(app)
      .post("/api/payments/intents")
      .set("Authorization", auth)
      .send({
        bookingId: (created.body as { booking: Booking }).booking.id,
        method: "paypal",
        phone: TEST_PHONE,
        paypal: { email: "buyer@example.com" },
      });
    expect(paypal.status).toBe(201);
    expect((paypal.body as { payment: PaymentIntent }).payment.method).toBe("paypal");
  });

  it("applies promo codes, volume discounts and the service charge", async () => {
    const session = await signUp("promo@example.com", "Promo User");
    const auth = `Bearer ${session.accessToken}`;
    const screening = (await request(app).get("/api/movies/furiosa?locale=en")).body as ScreeningResponse;
    const showtimeId = screening.screenings[0]!.days.at(-1)!.times[0]!.showtimeId;
    const seats = (await request(app).get(`/api/showtimes/${showtimeId}/seats`)).body as SeatMap;
    const ids = seats.seats
      .filter((seat) => seat.status === "available")
      .slice(0, 4)
      .map((seat) => seat.id);

    const promoRes = await request(app)
      .post("/api/promotions/validate")
      .send({ code: "cinema20", seatCount: 4 });
    expect(promoRes.status).toBe(200);
    expect(promoRes.body.appliedPercent).toBe(20);

    const bookingRes = await request(app)
      .post("/api/bookings")
      .set("Authorization", auth)
      .send({ showtimeId, seatIds: ids, promoCode: "CINEMA20" });
    expect(bookingRes.status).toBe(201);
    const booking = (bookingRes.body as { booking: Booking }).booking;

    // 4 seats also qualify for the automatic 10% volume discount, but the
    // better offer (20%) wins and offers never stack.
    expect(booking.quote.discountPercent).toBeGreaterThanOrEqual(20);
    expect(booking.quote.discountCents).toBe(
      Math.round((booking.quote.subtotalCents * booking.quote.discountPercent) / 100),
    );
    expect(booking.quote.totalCents).toBe(
      booking.quote.subtotalCents - booking.quote.discountCents + booking.quote.serviceFeeCents,
    );

    const invalid = await request(app)
      .post("/api/bookings")
      .set("Authorization", auth)
      .send({ showtimeId, seatIds: ids, promoCode: "NOPE" });
    expect(invalid.status).toBe(422);
  });

  it("does not let one user read another user's ticket", async () => {
    const owner = await signUp("owner@example.com");
    const stranger = await signUp("stranger@example.com");
    const screening = (await request(app).get("/api/movies/civil-war")).body as ScreeningResponse;
    const showtimeId = screening.screenings[0]!.days[0]!.times[0]!.showtimeId;
    const seats = (await request(app).get(`/api/showtimes/${showtimeId}/seats`)).body as SeatMap;
    const ids = seats.seats
      .filter((seat) => seat.status === "available")
      .slice(0, 1)
      .map((seat) => seat.id);

    const created = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ showtimeId, seatIds: ids });
    const bookingId = (created.body as { booking: Booking }).booking.id;

    const res = await request(app)
      .get(`/api/bookings/${bookingId}`)
      .set("Authorization", `Bearer ${stranger.accessToken}`);
    expect(res.status).toBe(404);
  });
});
