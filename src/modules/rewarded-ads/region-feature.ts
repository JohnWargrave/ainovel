import { db } from '../../db/index.js';

// The AdMob rewarded units the app ships (chapter_unlock buys a VIP novel chapter, not coin). A request naming anything else is rejected at the
// schema, and a NULL placement on an existing row means "created before placements existed".
export const REWARDED_AD_PLACEMENTS = ['checkin', 'earncoin', 'luckyspin', 'chapter_unlock'] as const;
export type RewardedAdPlacement = (typeof REWARDED_AD_PLACEMENTS)[number];

export interface RewardedAdPlacementFeature {
  daily_cap: number;
  cooldown_s: number;
  // Scales the eCPM-derived payout. 0 is meaningful and supported: a lucky-spin ad whose reward is
  // the spin itself should not also mint coin. See computeCoin in ssv.service.ts.
  coin_multiplier: number;
}

export interface RewardedAdsFeature {
  enabled: boolean;
  daily_cap: number;
  coin_cap: number;
  cooldown_s: number;
  est_ecpm_usd: number;
  timezone: string;
  placements: Partial<Record<RewardedAdPlacement, RewardedAdPlacementFeature>>;
}

const DEFAULTS: RewardedAdsFeature = {
  enabled: false,
  daily_cap: 20,
  coin_cap: 50,
  cooldown_s: 30,
  est_ecpm_usd: 0,
  timezone: 'UTC',
  placements: {},
};

const COIN_MULTIPLIER_MAX = 10;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Fractional counterpart to integerInRange — coin_multiplier is a scale factor, so 0.5 is valid.
function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function parsePlacements(
  value: unknown,
  fallbackDailyCap: number,
  fallbackCooldownS: number,
): Partial<Record<RewardedAdPlacement, RewardedAdPlacementFeature>> {
  const configured = asRecord(value);
  const parsed: Partial<Record<RewardedAdPlacement, RewardedAdPlacementFeature>> = {};
  for (const placement of REWARDED_AD_PLACEMENTS) {
    const entry = configured[placement];
    // Absent is not the same as misconfigured: a region that has never been told about a placement
    // should behave exactly as it did before placements existed, which is the top-level limits.
    if (!entry) continue;
    const record = asRecord(entry);
    parsed[placement] = {
      daily_cap: integerInRange(record['daily_cap'], 1, 1000, fallbackDailyCap),
      cooldown_s: integerInRange(record['cooldown_s'], 0, 86_400, fallbackCooldownS),
      coin_multiplier: boundedNumber(record['coin_multiplier'], 0, COIN_MULTIPLIER_MAX, 1),
    };
  }
  return parsed;
}

export function parseRewardedAdsFeature(featuresValue: unknown): RewardedAdsFeature {
  const features = asRecord(featuresValue);
  const rewardedAds = asRecord(features['rewarded_ads']);
  const dailyCap = integerInRange(rewardedAds['daily_cap'], 1, 1000, DEFAULTS.daily_cap);
  const cooldownS = integerInRange(rewardedAds['cooldown_s'], 0, 86_400, DEFAULTS.cooldown_s);
  return {
    enabled: rewardedAds['enabled'] === true,
    daily_cap: dailyCap,
    coin_cap: integerInRange(rewardedAds['coin_cap'], 1, 10_000_000, DEFAULTS.coin_cap),
    cooldown_s: cooldownS,
    est_ecpm_usd: nonNegativeNumber(rewardedAds['est_ecpm_usd'], DEFAULTS.est_ecpm_usd),
    timezone: typeof features['timezone'] === 'string' ? features['timezone'] : DEFAULTS.timezone,
    placements: parsePlacements(rewardedAds['placements'], dailyCap, cooldownS),
  };
}

// Flattens "which limits apply to this request" into one object so callers never have to remember
// the fallback rule. A null placement (legacy client, or a row created before this feature) gets the
// region-wide limits, which is the behaviour those rows were created under.
export function getPlacementFeature(
  feature: RewardedAdsFeature,
  placement: RewardedAdPlacement | null,
): RewardedAdPlacementFeature {
  const configured = placement ? feature.placements[placement] : undefined;
  return (
    configured ?? {
      daily_cap: feature.daily_cap,
      cooldown_s: feature.cooldown_s,
      coin_multiplier: 1,
    }
  );
}

// Mirrors offerwall-share.ts's pattern for reading region_config.features — no caching yet, same
// reasoning (low volume at this milestone, admin-editable without redeploy).
export async function getRewardedAdsFeature(regionId: string): Promise<RewardedAdsFeature> {
  const row = await db
    .selectFrom('region_config')
    .select('features')
    .where('region_id', '=', regionId)
    .executeTakeFirst();
  return parseRewardedAdsFeature(row?.features);
}
