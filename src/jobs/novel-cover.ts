import { Queue, Worker, type Job } from 'bullmq';
import type pino from 'pino';
import { queueRedis } from '../redis/index.js';
import { processCoverJob } from '../modules/novel/cover-ai/service.js';

export const QUEUE_NAME = 'novel-cover';

export interface NovelCoverPayload {
  jobId: string;
}

let queue: Queue | null = null;

// Created lazily in the API process (the CMS button and import commit enqueue here); the brief and
// the four renders run in the worker, about a minute per job.
export function getNovelCoverQueue(): Pick<Queue, 'add'> {
  queue ??= new Queue(QUEUE_NAME, { connection: queueRedis });
  return queue;
}

export function createNovelCoverWorker(logger: pino.Logger): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job<NovelCoverPayload>) => {
      await processCoverJob(job.data.jobId, logger);
    },
    // Mostly waiting on two HTTP APIs; two at a time keeps a bulk import from queueing for long
    // without hammering the Workers AI rate limit.
    { connection: queueRedis, concurrency: 2 },
  );
}
