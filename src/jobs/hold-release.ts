import { Queue, Worker, type Job } from 'bullmq';
import type pino from 'pino';
import { queueRedis } from '../redis/index.js';
import { db } from '../db/index.js';
import { releaseHold } from '../modules/wallet-ledger/ledger.service.js';

const QUEUE_NAME = 'hold-release';
const REPEAT_EVERY_MS = 5 * 60 * 1000;

export function createHoldReleaseQueue(): Queue {
  return new Queue(QUEUE_NAME, { connection: queueRedis });
}

export async function scheduleHoldReleaseRepeat(queue: Queue): Promise<void> {
  await queue.add('scan', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'hold-release-scan' });
}

// Scans for matured holds rather than scheduling one delayed job per credit — a single periodic
// sweep is simpler to reason about and self-heals if the worker was down when a hold matured.
async function processHoldReleaseScan(logger: pino.Logger): Promise<void> {
  const dueEntries = await db
    .selectFrom('coin_ledger')
    .select('id')
    .where('bucket', '=', 'pending')
    .where('hold_until', 'is not', null)
    .where('hold_until', '<=', new Date())
    .execute();

  for (const entry of dueEntries) {
    const result = await releaseHold(entry.id);
    if (result.released) {
      logger.info({ ledgerEntryId: entry.id }, 'hold released');
    }
  }
}

export function createHoldReleaseWorker(logger: pino.Logger): Worker {
  return new Worker(
    QUEUE_NAME,
    async (_job: Job) => {
      await processHoldReleaseScan(logger);
    },
    { connection: queueRedis },
  );
}
