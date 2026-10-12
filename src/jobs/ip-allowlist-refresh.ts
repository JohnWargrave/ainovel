import { uuidv7 } from 'uuidv7';
import { Queue, Worker, type Job } from 'bullmq';
import type pino from 'pino';
import { queueRedis } from '../redis/index.js';
import { db } from '../db/index.js';

const QUEUE_NAME = 'ip-allowlist-refresh';
const REPEAT_EVERY_MS = 7 * 24 * 60 * 60 * 1000; // weekly, 15-SCALE-RELIABILITY.md §7

export interface IpRangeSource {
  fetch(network: string): Promise<string[] | null>;
}

// TODO(verify): neither Tapjoy nor AdGate's exact public IP-range endpoint (if any) is confirmed —
// no live dashboard account exists yet. Reporting "no known source" here is deliberate: silently
// no-op-ing without saying so would look identical to "checked, nothing changed."
export const noopIpRangeSource: IpRangeSource = {
  fetch(): Promise<string[] | null> {
    return Promise.resolve(null);
  },
};

export function createIpAllowlistRefreshQueue(): Queue {
  return new Queue(QUEUE_NAME, { connection: queueRedis });
}

export async function scheduleIpAllowlistRefreshRepeat(queue: Queue): Promise<void> {
  await queue.add(
    'scan',
    {},
    { repeat: { every: REPEAT_EVERY_MS }, jobId: 'ip-allowlist-refresh-scan' },
  );
}

function sameIpSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((ip, i) => ip === sortedB[i]);
}

// Never auto-applies a detected range — a wrong detection would silently open or close the gateway.
// Flags drift into audit_log for manual admin review instead (no resolve UI yet — out of scope here).
export async function processIpAllowlistRefreshScan(
  logger: pino.Logger,
  source: IpRangeSource,
): Promise<void> {
  const networks = await db
    .selectFrom('network_config')
    .select(['network', 'allowed_ips'])
    .execute();

  for (const row of networks) {
    const detected = await source.fetch(row.network);
    if (detected === null) {
      logger.info({ network: row.network }, 'no known public IP source, skipped');
      continue;
    }
    if (sameIpSet(row.allowed_ips, detected)) continue;

    await db
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: null,
        action: 'IP_ALLOWLIST_DRIFT_DETECTED',
        target_type: 'network_config',
        target_id: null,
        detail: JSON.stringify({ network: row.network, current: row.allowed_ips, detected }),
        ip: null,
      })
      .execute();
    logger.warn(
      { network: row.network, current: row.allowed_ips, detected },
      'IP allowlist drift detected',
    );
  }
}

export function createIpAllowlistRefreshWorker(
  logger: pino.Logger,
  source: IpRangeSource = noopIpRangeSource,
): Worker {
  return new Worker(
    QUEUE_NAME,
    async (_job: Job) => {
      await processIpAllowlistRefreshScan(logger, source);
    },
    { connection: queueRedis },
  );
}
