import { Queue, Worker, type Job } from 'bullmq';
import type pino from 'pino';
import { queueRedis } from '../redis/index.js';
import { db } from '../db/index.js';
import { releaseHold } from '../modules/wallet-ledger/ledger.service.js';

const QUEUE_NAME = 'hold-release';
const REPEAT_EVERY_MS = 5 * 60 * 1000;
// Bounds one sweep's runtime; a backlog drains over consecutive runs.
const SCAN_BATCH_SIZE = 1000;

export function createHoldReleaseQueue(): Queue {
  return new Queue(QUEUE_NAME, { connection: queueRedis });
}

export async function scheduleHoldReleaseRepeat(queue: Queue): Promise<void> {
  await queue.add('scan', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'hold-release-scan' });
}

// Scans for matured holds rather than scheduling one delayed job per credit — a single periodic
// sweep is simpler to reason about and self-heals if the worker was down when a hold matured.
export async function processHoldReleaseScan(logger: pino.Logger): Promise<void> {
  const dueEntries = await db
    .selectFrom('coin_ledger')
    .innerJoin('users', 'users.id', 'coin_ledger.user_id')
    .select('coin_ledger.id')
    .where('coin_ledger.bucket', '=', 'pending')
    .where('coin_ledger.hold_until', 'is not', null)
    .where('coin_ledger.hold_until', '<=', new Date())
    // Held coin of suspended/banned accounts stays pending until they are reinstated.
    .where('users.status', '=', 'active')
    .orderBy('coin_ledger.hold_until')
    .limit(SCAN_BATCH_SIZE)
    .execute();

  for (const entry of dueEntries) {
    // One bad row must not abort the sweep for every other user — log it and move on; the row is
    // still due, so the next run retries it.
    try {
      const result = await releaseHold(entry.id);
      if (result.released) {
        logger.info({ ledgerEntryId: entry.id }, 'hold released');
      }
    } catch (err) {
      logger.error({ err, ledgerEntryId: entry.id }, 'hold release failed');
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
