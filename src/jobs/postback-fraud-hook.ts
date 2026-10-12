import { Queue, Worker, type Job } from 'bullmq';
import type pino from 'pino';
import { queueRedis } from '../redis/index.js';
import { evaluateClawbackRate } from '../modules/fraud/clawback-rule.js';
import { recomputeScore } from '../modules/fraud/score.service.js';

export const QUEUE_NAME = 'postback-fraud-hook';

export interface FraudHookPayload {
  earningEventId: string;
  userId: string;
  network: string;
}

// Created in the API process (postback.service.ts / rewarded-ads ssv.service.ts enqueue here after a
// credit commits); the Worker below runs in the worker process (registerJobs, see worker.ts) — same
// split as hold-release.
export function createPostbackFraudHookQueue(): Queue {
  return new Queue(QUEUE_NAME, { connection: queueRedis });
}

// Shared by every module that credits an earning event, so the checkpoint runs for every network
// (postback and rewarded-ads alike), not just the one that happened to be built first.
export function enqueueFraudHookJob(queue: Pick<Queue, 'add'>, payload: FraudHookPayload): void {
  void queue.add('evaluate', payload).catch(() => undefined);
}

// 05-FRAUD-ENGINE.md §1 async-per-earning-event checkpoint. Only E01 (clawback rate) runs here today —
// N01-N03 (IP/geo signals) have no data source (no IPinfo/IP2Proxy account), and B01-B02
// (completion-time/velocity percentile) need cohort-percentile infra this milestone doesn't build.
// Building unused ports/stubs for those now would be dead code, so they're left undone rather than
// half-wired — see backend_doing.md 1.5 for the explicit deferral.
export async function processFraudHookJob(payload: FraudHookPayload): Promise<void> {
  await evaluateClawbackRate(payload.userId);
  await recomputeScore(payload.userId);
}

export function createPostbackFraudHookWorker(_logger: pino.Logger): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job<FraudHookPayload>) => {
      await processFraudHookJob(job.data);
    },
    { connection: queueRedis },
  );
}
