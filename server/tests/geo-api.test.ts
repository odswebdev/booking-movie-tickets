import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { setupTestApp, teardownTestApp } from "./setup.js";

let app: Express;
let tempDir: string;

beforeAll(async () => {
  const ctx = await setupTestApp("movie-tickets-geo-");
  app = ctx.app;
  tempDir = ctx.tempDir;
});

afterAll(async () => {
  await teardownTestApp(tempDir);
});

interface RegionBody {
  region: {
    detected: boolean;
    provider: string;
    ip: string;
    cityId: string;
    countryCode: string;
    currency: string;
    latitude: number;
    longitude: number;
  };
}

interface CitiesBody {
  items: Array<{
    id: string;
    currency: string;
    center: { lat: number; lng: number };
    names: Record<string, string>;
  }>;
}

interface TheatersBody {
  items: Array<{
    id: string;
    name: string;
    cityId: string;
    address: string;
    coordinates?: { lat: number; lng: number };
    locale: string;
  }>;
}

describe("GET /api/geo", () => {
  it("falls back to the default city for local IPs", async () => {
    const res = await request(app).get("/api/geo").expect(200);
    const body = res.body as RegionBody;
    expect(body.region).toMatchObject({
      detected: false,
      provider: "mock",
      cityId: "nyc",
      currency: "USD",
    });
  });

  it("detects the city from X-Forwarded-For", async () => {
    const res = await request(app).get("/api/geo").set("X-Forwarded-For", "8.8.8.8").expect(200);
    const body = res.body as RegionBody;
    expect(body.region).toMatchObject({ detected: true, ip: "8.8.8.8", cityId: "nyc" });
  });
});

describe("GET /api/cities", () => {
  it("lists served cities with centers and localized names", async () => {
    const res = await request(app).get("/api/cities").expect(200);
    const body = res.body as CitiesBody;
    expect(body.items.map((city) => city.id)).toEqual(["nyc", "msk"]);
    expect(body.items[0]).toMatchObject({
      currency: "USD",
      center: { lat: 40.7128, lng: -74.006 },
      names: { en: "New York", ru: "Нью-Йорк" },
    });
  });
});

describe("GET /api/theaters", () => {
  it("lists every cinema with a city and coordinates", async () => {
    const res = await request(app).get("/api/theaters").expect(200);
    const body = res.body as TheatersBody;
    expect(body.items).toHaveLength(6);
    for (const theater of body.items) {
      expect(theater.cityId).toMatch(/^(nyc|msk)$/);
      expect(theater.coordinates).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number) });
    }
  });

  it("filters by city", async () => {
    const res = await request(app).get("/api/theaters?city=msk").expect(200);
    const body = res.body as TheatersBody;
    expect(body.items).toHaveLength(3);
    for (const theater of body.items) expect(theater.cityId).toBe("msk");
  });

  it("keeps the locale filter", async () => {
    const res = await request(app).get("/api/theaters?locale=ru").expect(200);
    const body = res.body as TheatersBody;
    expect(body.items).toHaveLength(3);
    for (const theater of body.items) expect(theater.locale).toBe("ru");
  });

  it("combines city and locale (empty intersection)", async () => {
    const res = await request(app).get("/api/theaters?city=msk&locale=en").expect(200);
    const body = res.body as TheatersBody;
    expect(body.items).toEqual([]);
  });

  it("rejects unknown cities with 422", async () => {
    const res = await request(app).get("/api/theaters?city=nope").expect(422);
    expect(res.body as unknown).toMatchObject({
      error: { message: expect.stringContaining("Unknown city") },
    });
  });
});
