import { db } from '../../db/index.js';

export interface ReferralFeature {
  enabled?: boolean;
  pct?: number;
  duration_months?: number | null;
  milestone_bonus_coin?: number;
  milestone_bonus_threshold?: number;
  hold_hours?: number;
  credit_immediately?: boolean;
}

export const DEFAULT_REFERRAL_FEATURE: Required<ReferralFeature> = {
  enabled: false,
  pct: 0.1,
  duration_months: null,
  milestone_bonus_coin: 0,
  milestone_bonus_threshold: 50_000,
  hold_hours: 0,
  credit_immediately: false,
};

export function parseReferralFeature(features: unknown): Required<ReferralFeature> {
  const feature = (features as { referral?: ReferralFeature } | null)?.referral;
  return { ...DEFAULT_REFERRAL_FEATURE, ...feature };
}

// Mirrors rewarded-ads/region-feature.ts's pattern for reading region_config.features — no caching
// yet, same reasoning (low volume at this milestone, admin-editable without redeploy).
export async function getReferralFeature(regionId: string): Promise<Required<ReferralFeature>> {
  const row = await db
    .selectFrom('region_config')
    .select('features')
    .where('region_id', '=', regionId)
    .executeTakeFirst();
  return parseReferralFeature(row?.features);
}
