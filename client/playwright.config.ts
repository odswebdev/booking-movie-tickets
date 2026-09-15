import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end suite (real Chromium, real API, isolated JSON datastore).
 *
 * The API boots in `test` mode with a fresh DATA_DIR per run, so specs never
 * touch development data. Specs run serially — they share one seat inventory.
 */

/** Isolated JSON datastore for the API under test (fresh per run). */
const apiDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cinetickets-e2e-"));

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run dev -w @movie-tickets/server",
      cwd: "..",
      port: 4000,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: "test",
        PORT: "4000",
        HOST: "127.0.0.1",
        DATA_DIR: apiDataDir,
        JWT_SECRET: "e2e-secret-value-that-is-long-enough",
        SERVE_CLIENT: "false",
        LOG_LEVEL: "silent",
      },
    },
    {
      command: "npm run dev -w @movie-tickets/client -- --port 5173 --strictPort",
      cwd: "..",
      port: 5173,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
