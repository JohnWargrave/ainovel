import { Type, type Static } from '@sinclair/typebox';

// Bounds mirror parseRewardedAdsFeature's own clamps in region-feature.ts — a value the CMS accepts
// but the reader silently replaces with a default would be a settings page that lies.
export const REWARDED_ADS_DAILY_CAP_MAX = 1000;
export const REWARDED_ADS_COOLDOWN_MAX_S = 86_400;
export const REWARDED_ADS_COIN_MULTIPLIER_MAX = 10;

const PlacementSettingsSchema = Type.Object({
  daily_cap: Type.Integer({ minimum: 1, maximum: REWARDED_ADS_DAILY_CAP_MAX }),
  cooldown_s: Type.Integer({ minimum: 0, maximum: REWARDED_ADS_COOLDOWN_MAX_S }),
  // 0 is a deliberate, supported value: it means this placement's ad grants its reward in kind
  // (a lucky-spin ad buys a spin) and mints no coin on top.
  coin_multiplier: Type.Number({ minimum: 0, maximum: REWARDED_ADS_COIN_MULTIPLIER_MAX }),
});

// Every placement optional: a region that has not configured one inherits the region-wide
// daily_cap / cooldown_s, which is exactly how it behaved before placements existed.
// Spelled out rather than derived from REWARDED_AD_PLACEMENTS so the static type stays exact —
// a computed Type.Object collapses to an index signature and stops matching RewardedAdsFeature.
const PlacementsSchema = Type.Object({
  checkin: Type.Optional(PlacementSettingsSchema),
  earncoin: Type.Optional(PlacementSettingsSchema),
  luckyspin: Type.Optional(PlacementSettingsSchema),
});

export const RewardedAdsRegionSettingsSchema = Type.Object({
  region_id: Type.String(),
  enabled: Type.Boolean(),
  daily_cap: Type.Integer(),
  cooldown_s: Type.Integer(),
  placements: PlacementsSchema,
  // Read-only context: the daily cap resets at midnight in this zone, and an operator setting a cap
  // needs to know which midnight that is.
  timezone: Type.String(),
  updated_at: Type.String(),
});
export type RewardedAdsRegionSettings = Static<typeof RewardedAdsRegionSettingsSchema>;

export const RewardedAdsSettingsListResponseSchema = Type.Object({
  items: Type.Array(RewardedAdsRegionSettingsSchema),
});

export const UpdateRewardedAdsRegionSettingsSchema = Type.Object({
  enabled: Type.Boolean(),
  daily_cap: Type.Integer({ minimum: 1, maximum: REWARDED_ADS_DAILY_CAP_MAX }),
  cooldown_s: Type.Integer({ minimum: 0, maximum: REWARDED_ADS_COOLDOWN_MAX_S }),
  // Omitted leaves the stored placements untouched, so a CMS build that predates this field cannot
  // silently wipe per-placement tuning by PUTting the rest of the form.
  placements: Type.Optional(PlacementsSchema),
});
export type UpdateRewardedAdsRegionSettings = Static<typeof UpdateRewardedAdsRegionSettingsSchema>;
