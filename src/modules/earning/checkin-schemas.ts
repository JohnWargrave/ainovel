import { Type, type Static } from '@sinclair/typebox';

export const CheckinClaimResponseSchema = Type.Object({
  credited_coin: Type.Number(),
  new_balance: Type.String(),
  streak_day: Type.Number(),
});
export type CheckinClaimResponse = Static<typeof CheckinClaimResponseSchema>;

// GET /config cannot carry this: it is public, unauthenticated, and cached in Redis per *region*
// for 60s, so per-user streak data served from there would leak between users.
export const CheckinStateResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  // The day of the reward cycle the *current* claim lands on — today's if `today_claimed`, else the
  // one a claim right now would earn. Highlight this day; do not derive it from `days_claimed`.
  streak_day: Type.Number(),
  // Consecutive days already credited, uncycled. 0 for an account that has never checked in.
  days_claimed: Type.Number(),
  today_claimed: Type.Boolean(),
  rewards: Type.Array(Type.Number()),
  next_reward_coin: Type.Number(),
  // Midnight in the region's timezone, expressed in UTC.
  reset_at: Type.String(),
  // "Watch a video to double it": the bonus POST /checkin/double would pay (today's reward), and
  // whether it has already been taken today.
  bonus_coin: Type.Number(),
  bonus_claimed_today: Type.Boolean(),
});
export type CheckinStateResponse = Static<typeof CheckinStateResponseSchema>;

export const CheckinDoubleBodySchema = Type.Object({
  intent_id: Type.String({ format: 'uuid' }),
});
export type CheckinDoubleBody = Static<typeof CheckinDoubleBodySchema>;

export const CheckinDoubleResponseSchema = Type.Object({
  credited_coin: Type.Number(),
  new_balance: Type.String(),
});
export type CheckinDoubleResponse = Static<typeof CheckinDoubleResponseSchema>;
