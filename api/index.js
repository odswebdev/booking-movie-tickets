/**
 * Vercel serverless adapter.
 *
 * Mirrors the bootstrap sequence of `server/src/index.ts` (database, FX rates,
 * promotions, catalog seed) and exports the Express app for /api/*.
 * `vercel.json` builds `server/dist` before functions are traced, so these
 * imports resolve to production-compiled ESM. Module scope runs once per
 * lambda instance (cold start).
 *
 * Demo mode: the Vercel project sets NODE_ENV=development + DATA_DIR=/tmp/...
 * which enables the zero-config JSON store and the mock payment/SMS providers
 * (the SMS code is echoed to the UI as `devCode` — no real phone needed).
 */
import { createApp } from "../server/dist/server/src/app.js";
import { env } from "../server/dist/server/src/config/env.js";
import { initDatabase } from "../server/dist/server/src/db/provider.js";
import { initCatalog } from "../server/dist/server/src/services/catalog.js";
import { configureRates, parseRateOverrides } from "../server/dist/server/src/services/fx.js";
import { seedPromocodes } from "../server/dist/server/src/services/loyaltyService.js";
import { configurePromotions } from "../server/dist/server/src/services/promotions.js";

await initDatabase();
configureRates(parseRateOverrides(env.FX_RATES));
configurePromotions();
await seedPromocodes().catch(() => 0);
await initCatalog();

const app = createApp();

export default app;
