import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { logger } from "../utils/logger.js";
import { createQueueConnection, handleEmailJob, handlePdfJob, handleSmsJob } from "./queueService.js";
import { QUEUE_EMAIL, QUEUE_PDF, QUEUE_SMS } from "./types.js";
import type { EmailSendJobData, PdfJobData, SmsJobData } from "./types.js";

/**
 * Starts one BullMQ worker per queue. Used by `src/worker.ts` and by tests
 * (in-process workers against the test Redis); the API itself only enqueues.
 */
export function startQueueWorkers(): Worker[] {
  const workers: Worker[] = [
    new Worker<SmsJobData>(QUEUE_SMS, (job: Job<SmsJobData>) => handleSmsJob(job.data), {
      connection: createQueueConnection(),
      concurrency: 10,
    }),
    new Worker<PdfJobData>(QUEUE_PDF, (job: Job<PdfJobData>) => handlePdfJob(job.data), {
      connection: createQueueConnection(),
      concurrency: 2,
    }),
    new Worker<EmailSendJobData>(QUEUE_EMAIL, (job: Job<EmailSendJobData>) => handleEmailJob(job.data), {
      connection: createQueueConnection(),
      concurrency: 5,
    }),
  ];
  for (const worker of workers) {
    worker.on("failed", (job, error) => {
      logger.error({ queue: worker.name, jobId: job?.id, err: error }, "background job failed");
    });
  }
  return workers;
}
