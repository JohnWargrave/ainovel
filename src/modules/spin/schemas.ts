import { Type, type Static } from '@sinclair/typebox';

export const SpinPrizeTypeSchema = Type.Union([
  Type.Literal('coin'),
  Type.Literal('voucher'),
  Type.Literal('boost'),
]);

export const SpinPrizeTierSchema = Type.Union([
  Type.Literal('low'),
  Type.Literal('mid'),
  Type.Literal('high'),
  Type.Literal('jackpot'),
]);

export const PrizeDisplaySchema = Type.Object({
  slot: Type.Integer(),
  type: SpinPrizeTypeSchema,
  value: Type.String(),
  tier: SpinPrizeTierSchema,
  label: Type.String(),
  pct: Type.Number(),
});

// Spins are funded by a rewarded ad. The client mints an intent via POST /earning/rewarded-ad/intent
// with placement "luckyspin", shows the ad, and passes the resulting intent_id here once AdMob's SSV
// callback has verified it.
export const SpinBodySchema = Type.Object({
  intent_id: Type.String({ format: 'uuid' }),
});
export type SpinBody = Static<typeof SpinBodySchema>;

export const SpinStateResponseSchema = Type.Object({
  // Always "0" since spins became ad-funded. Retained so clients that read it keep parsing.
  ticket_coin: Type.String(),
  spins_today: Type.Number(),
  // Already clamped by the remaining luckyspin ad quota — this is what the user can actually do.
  spins_remaining: Type.Number(),
  daily_cap: Type.Number(),
  ads_remaining: Type.Integer(),
  next_ad_available_at: Type.Union([Type.String(), Type.Null()]),
  free_spin_available: Type.Boolean(),
  reset_at: Type.String(),
  odds_disclosure: Type.String(),
  paid_prizes_display: Type.Array(PrizeDisplaySchema),
  free_prizes_display: Type.Array(PrizeDisplaySchema),
  // Backward-compatible alias for clients that shipped before the two tables were exposed.
  prizes_display: Type.Array(PrizeDisplaySchema),
});
export type SpinStateResponse = Static<typeof SpinStateResponseSchema>;

export const SpinResponseSchema = Type.Object({
  prize_slot: Type.Number(),
  prize_type: SpinPrizeTypeSchema,
  prize_value: Type.String(),
  new_balance: Type.String(),
});
export type SpinResponse = Static<typeof SpinResponseSchema>;

export const RecentWinItemSchema = Type.Object({
  username: Type.String(),
  prize_label: Type.String(),
  prize_value: Type.String(),
  created_at: Type.String(),
});

export const RecentWinsResponseSchema = Type.Object({
  wins: Type.Array(RecentWinItemSchema),
});
export type RecentWinsResponse = Static<typeof RecentWinsResponseSchema>;
