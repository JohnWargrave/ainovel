import { Queue, Worker, type Job } from 'bullmq';
import type pino from 'pino';
import { queueRedis } from '../redis/index.js';
import {
  processReferralCredit,
  type ReferralCreditPayload,
} from '../modules/referral/referral-credit.service.js';

export const QUEUE_NAME = 'referral-credit';

export type { ReferralCreditPayload };

// Created in the API process (postback.service.ts / rewarded-ads ssv.service.ts enqueue here after a
// backed credit commits); the Worker below runs in the worker process — same split as
// postback-fraud-hook and hold-release.
export function createReferralCreditQueue(): Queue {
  return new Queue(QUEUE_NAME, { connection: queueRedis });
}

// Enqueued unconditionally after every backed credit, mirroring enqueueFraudHookJob's philosophy —
// processReferralCredit itself cheaply no-ops for the common "user has no referrer" case.
export function enqueueReferralCreditJob(
  queue: Pick<Queue, 'add'>,
  payload: ReferralCreditPayload,
): void {
  void queue.add('credit', payload).catch(() => undefined);
}

export function createReferralCreditWorker(_logger: pino.Logger): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job<ReferralCreditPayload>) => {
      await processReferralCredit(job.data);
    },
    { connection: queueRedis },
  );
}
