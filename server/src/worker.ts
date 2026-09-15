/**
 * Background worker: processes the sms/email/pdf queues (BullMQ + Redis).
 *
 * Run: `npm run worker -w @movie-tickets/server` (needs REDIS_URL).
 * Without Redis the API executes the same pipeline inline — no worker needed.
 */
import { closeDatabase, initDatabase } from "./db/provider.js";
import { env } from "./config/env.js";
import { closeQueues, configureQueues } from "./queues/queueService.js";
import { startQueueWorkers } from "./queues/runner.js";
import { initCatalog } from "./services/catalog.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  if (!env.REDIS_URL) {
    logger.error("REDIS_URL must be set to run the queue worker (without Redis the API runs jobs inline)");
    process.exitCode = 1;
    return;
  }
  configureQueues("bullmq");
  await initDatabase();
  await initCatalog();
  const workers = startQueueWorkers();
  logger.info("queue workers started (sms, email, pdf)");

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    for (const worker of workers) {
      await worker.close();
    }
    await closeQueues();
    await closeDatabase();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

void main();
