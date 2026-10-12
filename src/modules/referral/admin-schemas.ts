import { Type, type Static } from '@sinclair/typebox';

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const REFERRAL_CODE_PATTERN = '^HP-[A-HJ-NP-Z2-9]{6}$';

export const AdminReferralSettingsSchema = Type.Object({
  region_id: Type.String(),
  enabled: Type.Boolean(),
  reward_pct: Type.Number(),
  duration_months: Type.Union([Type.Integer(), Type.Null()]),
  milestone_bonus_coin: Type.Integer(),
  milestone_bonus_threshold: Type.Integer(),
  hold_hours: Type.Integer(),
  credit_immediately: Type.Boolean(),
  updated_at: Type.String(),
});
export type AdminReferralSettings = Static<typeof AdminReferralSettingsSchema>;

export const AdminReferralSettingsListSchema = Type.Object({
  items: Type.Array(AdminReferralSettingsSchema),
});
export type AdminReferralSettingsList = Static<typeof AdminReferralSettingsListSchema>;

export const AdminReferralSettingsParamsSchema = Type.Object({
  region_id: Type.String({ minLength: 1, maxLength: 16 }),
});
export type AdminReferralSettingsParams = Static<typeof AdminReferralSettingsParamsSchema>;

export const AdminReferralSettingsUpdateSchema = Type.Object({
  enabled: Type.Boolean(),
  reward_pct: Type.Number({ minimum: 0, maximum: 0.5 }),
  duration_months: Type.Union([Type.Integer({ minimum: 1, maximum: 120 }), Type.Null()]),
  milestone_bonus_coin: Type.Integer({ minimum: 0, maximum: 10_000_000 }),
  milestone_bonus_threshold: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
  hold_hours: Type.Integer({ minimum: 0, maximum: 720 }),
  credit_immediately: Type.Boolean(),
});
export type AdminReferralSettingsUpdate = Static<typeof AdminReferralSettingsUpdateSchema>;

export const AdminReferralListQuerySchema = Type.Object({
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  region_id: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
  cursor: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type AdminReferralListQuery = Static<typeof AdminReferralListQuerySchema>;

export const AdminReferralSummarySchema = Type.Object({
  user_id: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  referral_code: Type.Union([Type.String(), Type.Null()]),
  region_id: Type.String(),
  status: Type.String(),
  total_referrals: Type.Integer(),
  qualified_referrals: Type.Integer(),
  pending_referrals: Type.Integer(),
  total_earned_coin: Type.String(),
  available_earned_coin: Type.String(),
  pending_earned_coin: Type.String(),
  clawed_back_coin: Type.String(),
  referral_frozen: Type.Boolean(),
  referral_blocked: Type.Boolean(),
});
export type AdminReferralSummary = Static<typeof AdminReferralSummarySchema>;

export const AdminReferralListResponseSchema = Type.Object({
  items: Type.Array(AdminReferralSummarySchema),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
});
export type AdminReferralListResponse = Static<typeof AdminReferralListResponseSchema>;

const AdminReferralUserSchema = Type.Object({
  id: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  referral_code: Type.Union([Type.String(), Type.Null()]),
  region_id: Type.String(),
  status: Type.String(),
  referral_qualified_at: Type.Union([Type.String(), Type.Null()]),
  referred_by_set_at: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
});

export const AdminReferralUserParamsSchema = Type.Object({
  id: Type.String({ pattern: UUID_PATTERN }),
});
export type AdminReferralUserParams = Static<typeof AdminReferralUserParamsSchema>;

export const AdminReferralDetailSchema = Type.Object({
  summary: AdminReferralSummarySchema,
  user: AdminReferralUserSchema,
  referrer: Type.Union([AdminReferralUserSchema, Type.Null()]),
  referred_users: Type.Array(AdminReferralUserSchema),
  recent_earnings: Type.Array(
    Type.Object({
      id: Type.String(),
      entry_type: Type.String(),
      amount: Type.String(),
      bucket: Type.String(),
      state: Type.Union([
        Type.Literal('available'),
        Type.Literal('pending'),
        Type.Literal('frozen'),
        Type.Literal('clawed_back'),
      ]),
      hold_until: Type.Union([Type.String(), Type.Null()]),
      source_event_id: Type.Union([Type.String(), Type.Null()]),
      created_at: Type.String(),
    }),
  ),
});
export type AdminReferralDetail = Static<typeof AdminReferralDetailSchema>;

export const AdminReferralCodeUpdateSchema = Type.Object({
  code: Type.String({ pattern: REFERRAL_CODE_PATTERN }),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
});
export type AdminReferralCodeUpdate = Static<typeof AdminReferralCodeUpdateSchema>;

export const AdminReferralCodeRegenerateSchema = Type.Object({
  reason: Type.String({ minLength: 3, maxLength: 500 }),
});
export type AdminReferralCodeRegenerate = Static<typeof AdminReferralCodeRegenerateSchema>;

export const AdminReferralFreezeClearSchema = Type.Object({
  reason: Type.String({ minLength: 3, maxLength: 500 }),
});
export type AdminReferralFreezeClear = Static<typeof AdminReferralFreezeClearSchema>;
