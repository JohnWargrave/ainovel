import { uuidv7 } from 'uuidv7';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { MIN_REDEMPTION_USD } from '../../lib/economy.js';
import { invalidateConfigCache } from '../config/config.service.js';
import type {
  RedemptionRegionSettings,
  RedemptionWeeklyCapInput,
  UpdateRedemptionRegionSettings,
} from './settings-schemas.js';

const DEFAULT_WEEKLY_CAPS: RedemptionWeeklyCapInput = {
  '0': MIN_REDEMPTION_USD,
  '1': MIN_REDEMPTION_USD,
  '2': 15,
  '3': 50,
};
const DEFAULT_CLAIM_HOLD_HOURS = 48;
const MAX_CLAIM_HOLD_HOURS = 720;

export interface RedemptionSettingsActor {
  id: string;
  role: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

// Mirrors parseClaimHoldHours in redemption.service.ts — an out-of-range stored value reads back as
// the default so the CMS shows what the runtime will actually apply.
function claimHoldHours(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_CLAIM_HOLD_HOURS
    ? value
    : DEFAULT_CLAIM_HOLD_HOURS;
}

function serializeSettings(row: {
  region_id: string;
  features: unknown;
  updated_at: Date | string;
}): RedemptionRegionSettings {
  const features = asRecord(row.features);
  const redemption = asRecord(features['redemption']);
  const storedCaps = asRecord(redemption['weekly_cap_usd']);
  return {
    region_id: row.region_id,
    enabled: redemption['enabled'] === true,
    weekly_cap_usd: {
      '0': positiveNumber(storedCaps['0'], DEFAULT_WEEKLY_CAPS['0']),
      '1': positiveNumber(storedCaps['1'], DEFAULT_WEEKLY_CAPS['1']),
      '2': positiveNumber(storedCaps['2'], DEFAULT_WEEKLY_CAPS['2']),
      '3': positiveNumber(storedCaps['3'], DEFAULT_WEEKLY_CAPS['3']),
    },
    claim_hold_hours: claimHoldHours(redemption['claim_hold_hours']),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function assertCapsProgressive(caps: RedemptionWeeklyCapInput): void {
  if (caps['0'] > caps['1'] || caps['1'] > caps['2'] || caps['2'] > caps['3']) {
    throw new AppError(
      'INVALID_REDEMPTION_CAPS',
      'Weekly caps must not decrease as trust level increases',
      400,
    );
  }
}

export async function listRedemptionSettings(): Promise<{
  min_redemption_usd: number;
  items: RedemptionRegionSettings[];
}> {
  const rows = await db
    .selectFrom('region_config')
    .select(['region_id', 'features', 'updated_at'])
    .orderBy('region_id', 'asc')
    .execute();
  return {
    min_redemption_usd: MIN_REDEMPTION_USD,
    items: rows.map(serializeSettings),
  };
}

export async function updateRedemptionSettings(
  regionId: string,
  input: UpdateRedemptionRegionSettings,
  actor: RedemptionSettingsActor,
  ip: string,
): Promise<RedemptionRegionSettings> {
  assertCapsProgressive(input.weekly_cap_usd);
  const updated = await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('region_config')
      .selectAll()
      .where('region_id', '=', regionId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError('CONFIG_NOT_FOUND', 'Region config not found', 404);

    const features = asRecord(before.features);
    const storedRedemption = asRecord(features['redemption']);
    const previous = serializeSettings(before);
    const redemption = {
      ...storedRedemption,
      enabled: input.enabled,
      weekly_cap_usd: input.weekly_cap_usd,
      claim_hold_hours: input.claim_hold_hours ?? previous.claim_hold_hours,
    };
    const updatedAt = new Date();
    await trx
      .updateTable('region_config')
      .set({ features: JSON.stringify({ ...features, redemption }), updated_at: updatedAt })
      .where('region_id', '=', regionId)
      .execute();
    await trx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: actor.id,
        action: 'REDEMPTION_SETTINGS_UPDATED',
        target_type: 'region_config',
        target_id: null,
        // Log the effective value, not the request body — claim_hold_hours may have been omitted
        // and inherited from the stored setting.
        detail: JSON.stringify({
          region_id: regionId,
          before: previous,
          after: { ...input, claim_hold_hours: redemption.claim_hold_hours },
        }),
        ip,
      })
      .execute();

    return serializeSettings({
      region_id: regionId,
      features: { redemption },
      updated_at: updatedAt,
    });
  });
  await invalidateConfigCache();
  return updated;
}
