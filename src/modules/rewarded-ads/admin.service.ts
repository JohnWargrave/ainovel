import { uuidv7 } from 'uuidv7';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { invalidateConfigCache } from '../config/config.service.js';
import { parseRewardedAdsFeature } from './region-feature.js';
import type {
  RewardedAdsRegionSettings,
  UpdateRewardedAdsRegionSettings,
} from './admin-schemas.js';

export interface RewardedAdsSettingsActor {
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
}): RewardedAdsRegionSettings {
  const feature = parseRewardedAdsFeature(row.features);
  return {
    region_id: row.region_id,
    enabled: feature.enabled,
    daily_cap: feature.daily_cap,
    cooldown_s: feature.cooldown_s,
    placements: feature.placements,
    timezone: feature.timezone,
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export async function listRewardedAdsSettings(): Promise<{ items: RewardedAdsRegionSettings[] }> {
  const rows = await db
    .selectFrom('region_config')
    .select(['region_id', 'features', 'updated_at'])
    .orderBy('region_id', 'asc')
    .execute();
  return { items: rows.map(serialize) };
}

export async function updateRewardedAdsSettings(
  regionId: string,
  input: UpdateRewardedAdsRegionSettings,
  actor: RewardedAdsSettingsActor,
  ip: string,
): Promise<RewardedAdsRegionSettings> {
  const updated = await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('region_config')
      .selectAll()
      .where('region_id', '=', regionId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError('CONFIG_NOT_FOUND', 'Region config not found', 404);

    const features = asRecord(before.features);
    // Spread the stored object rather than replacing it: coin_cap and est_ecpm_usd are economy
    // inputs this form does not expose, and dropping them would silently reprice every ad.
    const stored = asRecord(features['rewarded_ads']);
    const rewardedAds = {
      ...stored,
      enabled: input.enabled,
      daily_cap: input.daily_cap,
      cooldown_s: input.cooldown_s,
      // Same reasoning as the spread above, one level down: a form that does not send placements
      // must not erase them.
      placements: input.placements ?? stored['placements'] ?? {},
    };
    const updatedAt = new Date();
    await trx
      .updateTable('region_config')
      .set({
        features: JSON.stringify({ ...features, rewarded_ads: rewardedAds }),
        updated_at: updatedAt,
      })
      .where('region_id', '=', regionId)
      .execute();

    // Audited from the serialized result rather than from `input`: placements can be carried over
    // rather than supplied, and an audit row that only echoes the request would not show what the
    // region actually ended up with.
    const after = serialize({
      region_id: regionId,
      features: { ...features, rewarded_ads: rewardedAds },
      updated_at: updatedAt,
    });

    await trx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: actor.id,
        action: 'REWARDED_ADS_SETTINGS_UPDATED',
        target_type: 'region_config',
        target_id: null,
        detail: JSON.stringify({
          region_id: regionId,
          before: serialize(before),
          after,
        }),
        ip,
      })
      .execute();

    return after;
  });

  // /config caches the region payload, and rewarded_ads.daily_cap/cooldown_s ship inside it. Without
  // this the app keeps rendering the old cap until the TTL expires.
  await invalidateConfigCache();
  return updated;
}
