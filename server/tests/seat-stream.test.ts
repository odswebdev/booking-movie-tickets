import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestApp, teardownTestApp } from "./setup.js";

let app: Express;
let tempDir: string;

beforeAll(async () => {
  const ctx = await setupTestApp("movie-tickets-stream-");
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

describe("seat stream (SSE)", () => {
  it("pushes a seats event when a hold is placed", async () => {
    const screening = (await request(app).get("/api/movies/furiosa")).body as ScreeningResponse;
    const showtimeId = screening.screenings[0]!.days[0]!.times[0]!.showtimeId;
    const seats = (await request(app).get(`/api/showtimes/${showtimeId}/seats`)).body as SeatsResponse;
    const seatId = seats.seats.find((seat) => seat.status === "available")!.id;

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/showtimes/${showtimeId}/stream`, {
        headers: { Accept: "text/event-stream" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      if (!res.body) throw new Error("no response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const readUntil = async (needle: string, timeoutMs: number): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (!buffer.includes(needle)) {
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${needle}; got: ${JSON.stringify(buffer)}`);
          }
          const { done, value } = await reader.read();
          if (done) throw new Error(`stream ended before ${needle}`);
          buffer += decoder.decode(value, { stream: true });
        }
      };

      await readUntil("event: ready", 5000);

      // A change coming from another client must fan out to this stream.
      const hold = await request(app)
        .post(`/api/showtimes/${showtimeId}/holds`)
        .send({ seatIds: [seatId] });
      expect(hold.status).toBe(200);
      await readUntil("event: seats", 5000);

      await reader.cancel();
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("404s for an unknown showtime", async () => {
    const res = await request(app).get("/api/showtimes/nope/stream");
    expect(res.status).toBe(404);
  });
});
