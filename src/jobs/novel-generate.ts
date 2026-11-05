import { Queue, Worker, type Job } from 'bullmq';
import type pino from 'pino';
import { queueRedis } from '../redis/index.js';
import { processGenJob } from '../modules/novel/generate/service.js';

export const QUEUE_NAME = 'novel-gen';

export interface NovelGenPayload {
  projectId: string;
  runId: string;
}

let queue: Queue | null = null;

// Enqueued by the CMS (API process) and by the worker itself: a writing run is one job per chapter,
// each enqueueing the next, so a restart loses at most the chapter in flight.
export function getNovelGenQueue(): Pick<Queue, 'add'> {
  queue ??= new Queue(QUEUE_NAME, { connection: queueRedis });
  return queue;
}

export function createNovelGenWorker(logger: pino.Logger): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job<NovelGenPayload>) => {
      await processGenJob(job.data.projectId, job.data.runId, logger);
    },
    // Each job waits minutes on DeepSeek; a project only ever has one job queued, so this is how
    // many projects write at once.
    { connection: queueRedis, concurrency: 3, lockDuration: 120_000 },
  );
}
