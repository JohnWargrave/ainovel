import { Type, type Static } from '@sinclair/typebox';
import { MIN_REDEMPTION_USD } from '../../lib/economy.js';

const WeeklyCapResponseSchema = Type.Object({
  '0': Type.Number(),
  '1': Type.Number(),
  '2': Type.Number(),
  '3': Type.Number(),
});

export const RedemptionWeeklyCapInputSchema = Type.Object({
  '0': Type.Number({ minimum: MIN_REDEMPTION_USD, maximum: 10_000 }),
  '1': Type.Number({ minimum: MIN_REDEMPTION_USD, maximum: 10_000 }),
  '2': Type.Number({ minimum: MIN_REDEMPTION_USD, maximum: 10_000 }),
  '3': Type.Number({ minimum: MIN_REDEMPTION_USD, maximum: 10_000 }),
});
export type RedemptionWeeklyCapInput = Static<typeof RedemptionWeeklyCapInputSchema>;

// Hours a redeem request must age before the reward code can be opened, counted from the request.
// 0 disables the hold; 720 (30 days) is the ceiling.
export const RedemptionClaimHoldHoursSchema = Type.Integer({ minimum: 0, maximum: 720 });

export const RedemptionRegionSettingsSchema = Type.Object({
  region_id: Type.String(),
  enabled: Type.Boolean(),
  weekly_cap_usd: WeeklyCapResponseSchema,
  claim_hold_hours: Type.Integer(),
  updated_at: Type.String(),
});
export type RedemptionRegionSettings = Static<typeof RedemptionRegionSettingsSchema>;

export const RedemptionSettingsListResponseSchema = Type.Object({
  min_redemption_usd: Type.Number(),
  items: Type.Array(RedemptionRegionSettingsSchema),
});

export const UpdateRedemptionRegionSettingsSchema = Type.Object({
  enabled: Type.Boolean(),
  weekly_cap_usd: RedemptionWeeklyCapInputSchema,
  // Optional so existing CMS clients that predate the hold keep working — omitting it leaves the
  // stored value untouched rather than resetting it to the default.
  claim_hold_hours: Type.Optional(RedemptionClaimHoldHoursSchema),
});
export type UpdateRedemptionRegionSettings = Static<typeof UpdateRedemptionRegionSettingsSchema>;
