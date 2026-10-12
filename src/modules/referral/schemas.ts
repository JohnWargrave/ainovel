import { Type, type Static } from '@sinclair/typebox';

export const ReferralRedeemBodySchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 32 }),
});
export type ReferralRedeemBody = Static<typeof ReferralRedeemBodySchema>;

export const ReferralRedeemResponseSchema = Type.Object({
  ok: Type.Literal(true),
});

export const ReferralActivitySchema = Type.Object({
  coin: Type.Number(),
  at: Type.String(),
});

export const ReferralApplicationSchema = Type.Object({
  status: Type.Union([Type.Literal('eligible'), Type.Literal('applied'), Type.Literal('expired')]),
  // Global pre-submit eligibility only. A submitted code can still be rejected by RF01/RF04.
  can_redeem: Type.Boolean(),
  expires_at: Type.Union([Type.String(), Type.Null()]),
  applied_at: Type.Union([Type.String(), Type.Null()]),
});

// The referrer earns a share of what their referees earn, not a flat per-signup bounty, so the app
// is given the terms (`reward_pct`, milestone) instead of a `reward_per_referral` that would have to
// be invented. Mirrors region_config.features.referral.
export const ReferralTermsSchema = Type.Object({
  reward_pct: Type.Number(),
  milestone_bonus_coin: Type.Number(),
  milestone_bonus_threshold: Type.Number(),
  hold_hours: Type.Number(),
  credit_immediately: Type.Boolean(),
});

export const ReferralStatsResponseSchema = Type.Object({
  // Non-null: every user is issued a code at signup, and getReferralStats backfills any legacy row
  // that predates that. Kept a plain string so the app never has to render an empty share sheet.
  code: Type.String(),
  // Omitted rather than null when REFERRAL_SHARE_BASE_URL is unset — a half-built invite link is
  // worse than no link, because the app cannot tell the difference before sharing it.
  share_url: Type.Optional(Type.String()),
  total_referrals: Type.Number(),
  qualified_referrals: Type.Number(),
  pending_referrals: Type.Number(),
  total_earned_coin: Type.String(),
  terms: ReferralTermsSchema,
  recent_activity: Type.Array(ReferralActivitySchema),
  application: ReferralApplicationSchema,
});
export type ReferralStatsResponse = Static<typeof ReferralStatsResponseSchema>;
