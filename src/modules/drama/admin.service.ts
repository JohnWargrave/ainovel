import { uuidv7 } from 'uuidv7';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { invalidateConfigCache } from '../config/config.service.js';
import { parseDramaFeature } from './region-feature.js';
import type { DramaRegionSettings, UpdateDramaRegionSettings } from './admin-schemas.js';

export interface DramaSettingsActor {
  id: string;
  role: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function serialize(row: {
  region_id: string;
  features: unknown;
  updated_at: Date | string;
}): DramaRegionSettings {
  const feature = parseDramaFeature(row.features);
  // Same fallback as loadUserRegionFeatures: a region without an explicit timezone still shows the
  // day boundary the heartbeat's daily cap actually uses.
  const timezone = asRecord(row.features)['timezone'];
  return {
    region_id: row.region_id,
    enabled: feature.enabled,
    episode_reward_coin: feature.episode_reward_coin,
    completion_ratio: feature.completion_ratio,
    episode_reward_daily_cap: feature.episode_reward_daily_cap,
    timezone: typeof timezone === 'string' ? timezone : 'UTC',
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export async function listDramaSettings(): Promise<{ items: DramaRegionSettings[] }> {
  const rows = await db
    .selectFrom('region_config')
    .select(['region_id', 'features', 'updated_at'])
    .orderBy('region_id', 'asc')
    .execute();
  return { items: rows.map(serialize) };
}

export async function updateDramaSettings(
  regionId: string,
  input: UpdateDramaRegionSettings,
  actor: DramaSettingsActor,
  ip: string,
): Promise<DramaRegionSettings> {
  const updated = await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('region_config')
      .selectAll()
      .where('region_id', '=', regionId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError('CONFIG_NOT_FOUND', 'Region config not found', 404);

    const features = asRecord(before.features);
    // Spread the stored object rather than replacing it: catalog_region and interstitial_every are
    // app-facing keys this form does not expose, and dropping them would change what /config ships.
    const drama = {
      ...asRecord(features['drama']),
      enabled: input.enabled,
      episode_reward_coin: input.episode_reward_coin,
      completion_ratio: input.completion_ratio,
      episode_reward_daily_cap: input.episode_reward_daily_cap,
    };
    const updatedAt = new Date();
    await trx
      .updateTable('region_config')
      .set({ features: JSON.stringify({ ...features, drama }), updated_at: updatedAt })
      .where('region_id', '=', regionId)
      .execute();

    const after = serialize({
      region_id: regionId,
      features: { ...features, drama },
      updated_at: updatedAt,
    });

    await trx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: actor.id,
        action: 'DRAMA_SETTINGS_UPDATED',
        target_type: 'region_config',
        target_id: null,
        detail: JSON.stringify({ region_id: regionId, before: serialize(before), after }),
        ip,
      })
      .execute();

    return after;
  });

  // /config ships the whole parsed drama feature, and that payload is Redis-cached per region.
  // Without this the app keeps rendering the old reward for up to the TTL while the heartbeat
  // already credits the new one.
  await invalidateConfigCache();
  return updated;
}
