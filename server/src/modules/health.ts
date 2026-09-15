import { Router } from "express";
import { getCatalog } from "../services/catalog.js";
import { dbProvider, getRepositories } from "../db/provider.js";
import { redisMode } from "../redis/client.js";
import { sweepExpired } from "../services/bookingService.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const healthRouter: Router = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

healthRouter.get(
  "/health/ready",
  asyncHandler(async (_req, res) => {
    try {
      await sweepExpired();
      const repos = getRepositories();
      const [users, bookings, payments] = await Promise.all([
        repos.users.count(),
        repos.bookings.count(),
        repos.payments.count(),
      ]);
      res.json({
        status: "ready",
        counts: { users, bookings, payments },
        showtimes: getCatalog().showtimes.length,
        db: dbProvider(),
        holds: redisMode(),
      });
    } catch (error) {
      res.status(503).json({ status: "unavailable", message: (error as Error).message });
    }
  }),
);
