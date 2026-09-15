import { Router } from "express";
import { z } from "zod";
import { CITIES, cityById } from "../geo/cities.js";
import { attachRegion } from "../middleware/region.js";
import { validate } from "../middleware/validate.js";
import { getCatalog } from "../services/catalog.js";
import { ApiError } from "../utils/errors.js";

export const geoRouter: Router = Router();

/** Detected region: client IP → geo lookup → served city + currency. */
geoRouter.get("/geo", attachRegion, (req, res) => {
  res.json({ region: req.region });
});

/** Served cities with localized names, map centers and currencies. */
geoRouter.get("/cities", (_req, res) => {
  res.json({ items: CITIES });
});

const theatersQuerySchema = z.object({
  city: z.string().min(1).max(32).optional(),
  locale: z.enum(["en", "ru"]).optional(),
});

/** Cinemas, optionally filtered by city and/or locale. */
geoRouter.get("/theaters", validate(theatersQuerySchema, "query"), (req, res) => {
  const { city, locale } = req.query as z.infer<typeof theatersQuerySchema>;
  if (city && !cityById(city)) {
    throw ApiError.validation("Unknown city", [{ field: "city", message: `Unknown city: ${city}` }]);
  }
  const items = getCatalog()
    .theatersForLocale(locale)
    .filter((theater) => !city || theater.cityId === city);
  res.json({ items });
});
