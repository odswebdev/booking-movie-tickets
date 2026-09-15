import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestApp, teardownTestApp } from "./setup.js";
import request from "supertest";
import type { Express } from "express";
import type { AuthSession } from "../../shared/types.js";

/**
 * Two tabs refreshing at the same time replay the *old* refresh token. That is
 * a race, not a theft — it must not log the user out (this used to revoke every
 * session of the account, leaving the user unable to sign back in).
 */
let app: Express;
let tempDir: string;

beforeAll(async () => {
  const ctx = await setupTestApp("movie-tickets-auth-", {
    JWT_ACCESS_TTL: "30s", // any unit must be accepted
    // Default grace window (60s) is what we want to exercise here.
    REFRESH_REUSE_GRACE_MS: undefined,
  });
  app = ctx.app;
  tempDir = ctx.tempDir;
});

afterAll(async () => {
  await teardownTestApp(tempDir);
});

async function signUp(email: string): Promise<AuthSession> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: "Refresh Tester", email, password: "Passw0rdDemo", confirmPassword: "Passw0rdDemo" });
  expect(res.status).toBe(201);
  return res.body as AuthSession;
}

describe("session refresh", () => {
  it("accepts non-minute access TTLs (30s, 1h, 7d)", async () => {
    const session = await signUp("ttl@example.com");
    expect(session.accessToken).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(session.accessToken.split(".")[1] ?? "", "base64").toString());
    // 30s TTL → exp-iat must be 30 seconds, not NaN.
    expect(decoded.exp - decoded.iat).toBe(30);
  });

  it("rotates the refresh token and keeps the session usable", async () => {
    const session = await signUp("rotate@example.com");

    const refreshed = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: session.refreshToken });
    expect(refreshed.status).toBe(200);
    const rotated = refreshed.body as AuthSession;
    expect(rotated.refreshToken).not.toBe(session.refreshToken);

    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${rotated.accessToken}`);
    expect(me.status).toBe(200);
  });

  it("survives a second tab replaying the rotated token inside the grace window", async () => {
    const session = await signUp("race@example.com");

    const first = await request(app).post("/api/auth/refresh").send({ refreshToken: session.refreshToken });
    expect(first.status).toBe(200);

    // The other tab still holds the pre-rotation token.
    const replay = await request(app).post("/api/auth/refresh").send({ refreshToken: session.refreshToken });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);

    const replayed = replay.body as AuthSession;
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${replayed.accessToken}`);
    expect(me.status).toBe(200);
  });

  it("rejects an unknown refresh token", async () => {
    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: "definitely-not-a-token" });
    expect(res.status).toBe(401);
  });
});
