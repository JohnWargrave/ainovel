import { Type, type Static } from '@sinclair/typebox';

// Bounds mirror parseDramaFeature's own clamps in region-feature.ts — a value the CMS accepts but
// the reader silently replaces with a default would be a settings page that lies.
export const DRAMA_EPISODE_REWARD_COIN_MAX = 1_000_000;
export const DRAMA_COMPLETION_RATIO_MIN = 0.1;
export const DRAMA_COMPLETION_RATIO_MAX = 1;
export const DRAMA_DAILY_CAP_MAX = 10_000;

export const DramaRegionSettingsSchema = Type.Object({
  region_id: Type.String(),
  enabled: Type.Boolean(),
  // 0 is a supported value: it keeps the player and its progress tracking live while paying nothing.
  episode_reward_coin: Type.Integer(),
  completion_ratio: Type.Number(),
  episode_reward_daily_cap: Type.Integer(),
  // Read-only context: the daily cap resets at midnight in this zone, and an operator setting a cap
  // needs to know which midnight that is.
  timezone: Type.String(),
  updated_at: Type.String(),
});
export type DramaRegionSettings = Static<typeof DramaRegionSettingsSchema>;

export const DramaSettingsListResponseSchema = Type.Object({
  items: Type.Array(DramaRegionSettingsSchema),
});

export const UpdateDramaRegionSettingsSchema = Type.Object({
  enabled: Type.Boolean(),
  episode_reward_coin: Type.Integer({ minimum: 0, maximum: DRAMA_EPISODE_REWARD_COIN_MAX }),
  completion_ratio: Type.Number({
    minimum: DRAMA_COMPLETION_RATIO_MIN,
    maximum: DRAMA_COMPLETION_RATIO_MAX,
  }),
  // 0 is reachable and means "no rewarded episodes today" — an operator throttling a region to zero
  // without turning the player off.
  episode_reward_daily_cap: Type.Integer({ minimum: 0, maximum: DRAMA_DAILY_CAP_MAX }),
});
export type UpdateDramaRegionSettings = Static<typeof UpdateDramaRegionSettingsSchema>;
