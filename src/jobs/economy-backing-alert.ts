import { uuidv7 } from 'uuidv7';
import { sql } from 'kysely';
import { Queue, Worker, type Job } from 'bullmq';
import type pino from 'pino';
import { queueRedis } from '../redis/index.js';
import { db } from '../db/index.js';
import { getBackingRatio } from '../modules/wallet-ledger/economy-counters.js';
import { invalidateConfigCache } from '../modules/config/config.service.js';

const QUEUE_NAME = 'economy-backing-alert';
const REPEAT_EVERY_MS = 15 * 60 * 1000;
// 01-COIN-ECONOMY.md §5: revenue must cover at least 1.2x the coin minted.
export const BACKING_RATIO_THRESHOLD = 1.2;
export const SHARE_REDUCTION_THRESHOLD = 1.15;
export const AUTO_APPROVAL_PAUSE_THRESHOLD = 1.0;
const ALERT_ACTION = 'ECONOMY_BACKING_LOW';

export function createEconomyBackingAlertQueue(): Queue {
  return new Queue(QUEUE_NAME, { connection: queueRedis });
}

export async function scheduleEconomyBackingAlertRepeat(queue: Queue): Promise<void> {
  await queue.add(
    'scan',
    {},
    { repeat: { every: REPEAT_EVERY_MS }, jobId: 'economy-backing-alert-scan' },
  );
}

// The counters this reads are per-day, so one alert per region per day is the whole signal — the
// 15-minute cadence exists to catch it early, not to repeat it 96 times. Same dedupe shape as
// IP_ALLOWLIST_DRIFT_DETECTED in ip-allowlist-refresh.ts.
// The region lives in `detail` rather than `target_id` because that column is a UUID and a region id
// is not one — same reason REGION_CONFIG_UPDATED stores it there.
async function alreadyAlertedToday(regionId: string): Promise<boolean> {
  const existing = await db
    .selectFrom('audit_log')
    .select('id')
    .where('action', '=', ALERT_ACTION)
    .where(sql<string>`detail->>'region'`, '=', regionId)
    .where('created_at', '>=', sql<Date>`date_trunc('day', now())`)
    .executeTakeFirst();
  return existing !== undefined;
}

async function applySafetyValve(regionId: string, ratio: number): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('region_config')
      .select('features')
      .where('region_id', '=', regionId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return false;
    const features =
      row.features && typeof row.features === 'object' && !Array.isArray(row.features)
        ? { ...(row.features as Record<string, unknown>) }
        : {};
    const economyValue = features['economy'];
    const economy =
      economyValue && typeof economyValue === 'object' && !Array.isArray(economyValue)
        ? { ...(economyValue as Record<string, unknown>) }
        : {};
    const nextFactor = ratio < SHARE_REDUCTION_THRESHOLD ? 0.8 : 1;
    const nextAutoApprovalPaused = ratio < AUTO_APPROVAL_PAUSE_THRESHOLD;
    if (
      economy['share_rate_factor'] === nextFactor &&
      economy['auto_approve_paused'] === nextAutoApprovalPaused
    )
      return false;
    economy['share_rate_factor'] = nextFactor;
    economy['auto_approve_paused'] = nextAutoApprovalPaused;
    features['economy'] = economy;
    await trx
      .updateTable('region_config')
      .set({ features: JSON.stringify(features), updated_at: new Date() })
      .where('region_id', '=', regionId)
      .execute();
    await trx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: null,
        action: 'ECONOMY_SAFETY_VALVE_APPLIED',
        target_type: 'region_config',
        target_id: null,
        detail: JSON.stringify({
          region: regionId,
          ratio,
          share_rate_factor: economy['share_rate_factor'],
          auto_approve_paused: economy['auto_approve_paused'],
        }),
        ip: null,
      })
      .execute();
    return true;
  });
}

export async function processEconomyBackingAlertScan(logger: pino.Logger): Promise<number> {
  const regions = await db.selectFrom('region_config').select('region_id').execute();

  let alerts = 0;
  for (const region of regions) {
    const ratio = await getBackingRatio(region.region_id);
    // null = nothing minted in this region today. That is "no ratio", not a ratio of 0 — alerting on
    // it would fire for every idle region every morning and train the team to ignore the alert.
    if (ratio === null) continue;
    if (await applySafetyValve(region.region_id, ratio)) await invalidateConfigCache();
    if (ratio >= BACKING_RATIO_THRESHOLD) continue;
    if (await alreadyAlertedToday(region.region_id)) continue;

    await db
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: null,
        action: ALERT_ACTION,
        target_type: 'region_config',
        target_id: null,
        detail: JSON.stringify({
          region: region.region_id,
          ratio,
          threshold: BACKING_RATIO_THRESHOLD,
        }),
        ip: null,
      })
      .execute();
    logger.error(
      { region: region.region_id, ratio, threshold: BACKING_RATIO_THRESHOLD },
      'coin backing ratio below threshold',
    );
    alerts += 1;
  }
  return alerts;
}

export function createEconomyBackingAlertWorker(logger: pino.Logger): Worker {
  return new Worker(
    QUEUE_NAME,
    async (_job: Job) => {
      await processEconomyBackingAlertScan(logger);
    },
    { connection: queueRedis },
  );
}
