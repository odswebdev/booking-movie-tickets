import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestApp, teardownTestApp } from "./setup.js";
import request from "supertest";
import type { Express } from "express";
import type { AuthSession } from "../../shared/types.js";

/**
 * With the grace window disabled, replaying a rotated token is treated as
 * theft. Even then the user must be able to recover: only the sessions that
 * existed when the token was rotated are revoked, never a newer sign-in.
 */
let app: Express;
let tempDir: string;

beforeAll(async () => {
  const ctx = await setupTestApp("movie-tickets-reuse-", { REFRESH_REUSE_GRACE_MS: "0" });
  app = ctx.app;
  tempDir = ctx.tempDir;
});

afterAll(async () => {
  await teardownTestApp(tempDir);
});

async function signUp(email: string): Promise<AuthSession> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: "Reuse Tester", email, password: "Passw0rdDemo", confirmPassword: "Passw0rdDemo" });
  expect(res.status).toBe(201);
  return res.body as AuthSession;
}

describe("refresh token reuse", () => {
  it("revokes the stolen session but lets the user sign in again", async () => {
    const email = "reuse@example.com";
    const session = await signUp(email);

    // Rotate: the old token is now retired.
    const rotated = await request(app).post("/api/auth/refresh").send({ refreshToken: session.refreshToken });
    expect(rotated.status).toBe(200);
    const rotatedSession = rotated.body as AuthSession;

    // Replay of the retired token → 401, and the rotated session dies with it.
    const replay = await request(app).post("/api/auth/refresh").send({ refreshToken: session.refreshToken });
    expect(replay.status).toBe(401);

    const afterReplay = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: rotatedSession.refreshToken });
    expect(afterReplay.status).toBe(401);

    // A fresh sign-in is untouched and works.
    const again = await request(app).post("/api/auth/login").send({ email, password: "Passw0rdDemo" });
    expect(again.status).toBe(200);
    const fresh = again.body as AuthSession;

    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${fresh.accessToken}`);
    expect(me.status).toBe(200);

    // …and keeps working even if the stolen token is replayed once more.
    const replayAgain = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: session.refreshToken });
    expect(replayAgain.status).toBe(401);

    const stillWorks = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: fresh.refreshToken });
    expect(stillWorks.status).toBe(200);
  });
});
