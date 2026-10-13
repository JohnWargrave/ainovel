import { Queue, Worker, type Job } from 'bullmq';
import type pino from 'pino';
import { queueRedis } from '../redis/index.js';
import { processImportJob } from '../modules/novel/import/import.service.js';

export const QUEUE_NAME = 'novel-import';

export interface NovelImportPayload {
  jobId: string;
}

let queue: Queue | null = null;

// Created lazily in the API process (the CMS upload enqueues here); parsing runs in the worker so a
// large EPUB never blocks request handling.
export function getNovelImportQueue(): Pick<Queue, 'add'> {
  queue ??= new Queue(QUEUE_NAME, { connection: queueRedis });
  return queue;
}

export function createNovelImportWorker(logger: pino.Logger): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job<NovelImportPayload>) => {
      await processImportJob(job.data.jobId, logger);
    },
    // Parsing is CPU- and memory-heavy; one at a time per worker process.
    { connection: queueRedis, concurrency: 1 },
  );
}
