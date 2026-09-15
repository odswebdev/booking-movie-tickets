import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { AuthSession } from "../../shared/types.js";
import { setupTestApp, teardownTestApp } from "./setup.js";

let app: Express;
let tempDir: string;

beforeAll(async () => {
  const ctx = await setupTestApp("movie-tickets-race-");
  app = ctx.app;
  tempDir = ctx.tempDir;
});

afterAll(async () => {
  await teardownTestApp(tempDir);
});

interface ScreeningResponse {
  screenings: Array<{ days: Array<{ times: Array<{ showtimeId: string }> }> }>;
}

interface SeatsResponse {
  seats: Array<{ id: string; status: string }>;
}

async function pickSeats(
  count: number,
  dayIndex: number,
): Promise<{ showtimeId: string; seatIds: string[] }> {
  const screening = (await request(app).get("/api/movies/furiosa")).body as ScreeningResponse;
  const showtimeId = screening.screenings[0]!.days[dayIndex]!.times[0]!.showtimeId;
  const seats = (await request(app).get(`/api/showtimes/${showtimeId}/seats`)).body as SeatsResponse;
  const seatIds = seats.seats.filter((seat) => seat.status === "available").map((seat) => seat.id);
  return { showtimeId, seatIds: seatIds.slice(0, count) };
}

async function signUp(email: string): Promise<AuthSession> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: "Race Tester", email, password: "Str0ngPassw0rd", confirmPassword: "Str0ngPassw0rd" });
  expect(res.status).toBe(201);
  return res.body as AuthSession;
}

describe("concurrent seat races", () => {
  it("grants the hold to exactly one of ten racers", async () => {
    const { showtimeId, seatIds } = await pickSeats(2, 0);
    expect(seatIds).toHaveLength(2);

    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(app)
          .post(`/api/showtimes/${showtimeId}/holds`)
          .set("X-Hold-Token", `racer-${i}`)
          .send({ seatIds }),
      ),
    );

    const winners = attempts.filter((res) => res.status === 200);
    const losers = attempts.filter((res) => res.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);
    for (const res of losers) expect(res.body.error.code).toBe("seat_unavailable");
  });

  it("confirms exactly one of two simultaneous bookings for the same seats", async () => {
    const { showtimeId, seatIds } = await pickSeats(2, 1);
    expect(seatIds).toHaveLength(2);
    const [first, second] = await Promise.all([signUp("race1@example.com"), signUp("race2@example.com")]);

    const attempts = await Promise.all([
      request(app)
        .post("/api/bookings")
        .set("Authorization", `Bearer ${first.accessToken}`)
        .send({ showtimeId, seatIds }),
      request(app)
        .post("/api/bookings")
        .set("Authorization", `Bearer ${second.accessToken}`)
        .send({ showtimeId, seatIds }),
    ]);

    const statuses = attempts.map((res) => res.status).sort();
    expect(statuses).toEqual([201, 409]);
    const loser = attempts.find((res) => res.status === 409)!;
    expect(loser.body.error.code).toBe("seat_unavailable");
  });
});
