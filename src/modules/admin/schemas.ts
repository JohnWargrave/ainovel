import { Type, type Static } from '@sinclair/typebox';

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export const AdminUserParamsSchema = Type.Object({ id: Type.String({ pattern: UUID_PATTERN }) });
export interface AdminUserParams {
  id: string;
}

// A reason is mandatory on every account action: `audit_log.detail` is the only record of why an
// account was locked, and "no reason given" makes an appeal impossible to review later.
export const AdminUserActionBodySchema = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 500 }),
});
export type AdminUserActionBody = Static<typeof AdminUserActionBodySchema>;

export const AdminTrustLevelBodySchema = Type.Object({
  // 02-DATABASE-SCHEMA.md §users: trust_level is 0..3.
  trust_level: Type.Integer({ minimum: 0, maximum: 3 }),
  reason: Type.String({ minLength: 1, maxLength: 500 }),
});

export const AdminTestCreditBodySchema = Type.Object({
  amount_coin: Type.Integer({ minimum: 1, maximum: 100_000 }),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
  idempotency_key: Type.String({ minLength: 8, maxLength: 128 }),
});
export type AdminTestCreditBody = Static<typeof AdminTestCreditBodySchema>;

export const AdminTestCreditResponseSchema = Type.Object({
  ledger_id: Type.String(),
  amount_coin: Type.Number(),
  previous_balance: Type.String(),
  new_balance: Type.String(),
  deduped: Type.Boolean(),
});
export type AdminTestCreditResponse = Static<typeof AdminTestCreditResponseSchema>;
export type AdminTrustLevelBody = Static<typeof AdminTrustLevelBodySchema>;

export const AdminCoinAdjustmentBodySchema = Type.Object({
  amount_coin: Type.Integer({ minimum: -100_000, maximum: 100_000, not: { const: 0 } }),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
  idempotency_key: Type.String({ minLength: 8, maxLength: 128 }),
});
export type AdminCoinAdjustmentBody = Static<typeof AdminCoinAdjustmentBodySchema>;

export const AdminCredentialParamsSchema = Type.Object({
  id: Type.String({ pattern: UUID_PATTERN }),
  provider: Type.Union([
    Type.Literal('guest'),
    Type.Literal('google'),
    Type.Literal('facebook'),
    Type.Literal('password'),
  ]),
});
export type AdminCredentialParams = Static<typeof AdminCredentialParamsSchema>;

export const AdminSessionParamsSchema = Type.Object({
  id: Type.String({ pattern: UUID_PATTERN }),
  sessionId: Type.String({ pattern: UUID_PATTERN }),
});
export type AdminSessionParams = Static<typeof AdminSessionParamsSchema>;

export const AdminUserDetailSchema = Type.Object({
  id: Type.String(),
  auth_provider: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  country_code: Type.String(),
  region_id: Type.String(),
  status: Type.String(),
  trust_level: Type.Integer(),
  fraud_score: Type.Integer(),
  referral_code: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  wallet: Type.Object({
    available_coin: Type.String(),
    pending_coin: Type.String(),
    lifetime_earned: Type.String(),
    lifetime_redeemed: Type.String(),
  }),
  open_flag_count: Type.Integer(),
  password_credential: Type.Union([
    Type.Object({
      username: Type.String(),
      email: Type.String(),
      email_verified_at: Type.Union([Type.String(), Type.Null()]),
      password_changed_at: Type.String(),
      disabled_at: Type.Union([Type.String(), Type.Null()]),
      created_at: Type.String(),
    }),
    Type.Null(),
  ]),
  identities: Type.Array(
    Type.Object({
      provider: Type.String(),
      email: Type.Union([Type.String(), Type.Null()]),
      email_verified_at: Type.Union([Type.String(), Type.Null()]),
      last_used_at: Type.String(),
      disabled_at: Type.Union([Type.String(), Type.Null()]),
      created_at: Type.String(),
    }),
  ),
  welcome_credit: Type.Object({
    granted: Type.Boolean(),
    amount: Type.Union([Type.String(), Type.Null()]),
    granted_at: Type.Union([Type.String(), Type.Null()]),
  }),
  active_sessions: Type.Array(
    Type.Object({
      id: Type.String(),
      provider: Type.String(),
      device_id: Type.Union([Type.String(), Type.Null()]),
      ip: Type.Union([Type.String(), Type.Null()]),
      user_agent: Type.Union([Type.String(), Type.Null()]),
      created_at: Type.String(),
      last_used_at: Type.String(),
      expires_at: Type.String(),
    }),
  ),
  auth_events: Type.Array(
    Type.Object({
      id: Type.String(),
      provider: Type.String(),
      event_type: Type.String(),
      outcome: Type.String(),
      failure_code: Type.Union([Type.String(), Type.Null()]),
      ip: Type.Union([Type.String(), Type.Null()]),
      device_id: Type.Union([Type.String(), Type.Null()]),
      metadata: Type.Unknown(),
      created_at: Type.String(),
    }),
  ),
  ledger: Type.Array(
    Type.Object({
      id: Type.String(),
      entry_type: Type.String(),
      amount: Type.String(),
      bucket: Type.String(),
      balance_after: Type.String(),
      note: Type.Union([Type.String(), Type.Null()]),
      created_at: Type.String(),
    }),
  ),
  admin_audit: Type.Array(
    Type.Object({
      id: Type.String(),
      admin_user_id: Type.Union([Type.String(), Type.Null()]),
      action: Type.String(),
      detail: Type.Unknown(),
      created_at: Type.String(),
    }),
  ),
});
export type AdminUserDetail = Static<typeof AdminUserDetailSchema>;

export const EconomyAnalyticsQuerySchema = Type.Object({
  // Validated by Date.parse in the service rather than an ajv `format` keyword — nothing else in the
  // codebase relies on ajv-formats being registered, and this is the only place that would.
  from: Type.Optional(Type.String({ minLength: 4, maxLength: 32 })),
  to: Type.Optional(Type.String({ minLength: 4, maxLength: 32 })),
  region: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
});
export type EconomyAnalyticsQuery = Static<typeof EconomyAnalyticsQuerySchema>;

const AmountByKeySchema = Type.Record(Type.String(), Type.String());

export const EconomyAnalyticsResponseSchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
  region: Type.Union([Type.String(), Type.Null()]),
  coin_minted_by_source: AmountByKeySchema,
  coin_burned_by_sink: AmountByKeySchema,
  coin_minted_total: Type.String(),
  coin_burned_total: Type.String(),
  unbacked_coin: Type.String(),
  unbacked_pct: Type.Number(),
  coin_redeemed_usd_cost: Type.Number(),
  revenue_usd: Type.Number(),
  clawback_rate_by_network: Type.Record(Type.String(), Type.Number()),
  // Redis day counters, not a range aggregate — `from`/`to` do not apply to these two. Kept in the
  // same payload because it is the number the alert job fires on.
  backing_ratio_today: Type.Union([Type.Number(), Type.Null()]),
  mint_paused: Type.Boolean(),
});
export type EconomyAnalyticsResponse = Static<typeof EconomyAnalyticsResponseSchema>;

// Every other analytics endpoint returns one collapsed number per range, which cannot answer "is this
// getting better or worse". This one keeps the day buckets.
export const AnalyticsTimeseriesQuerySchema = Type.Object({
  days: Type.Optional(Type.Integer({ minimum: 2, maximum: 180 })),
  region: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
});
export type AnalyticsTimeseriesQuery = Static<typeof AnalyticsTimeseriesQuerySchema>;

export const AnalyticsTimeseriesPointSchema = Type.Object({
  // UTC calendar day, YYYY-MM-DD.
  date: Type.String(),
  coin_minted: Type.String(),
  coin_burned: Type.String(),
  new_users: Type.Integer(),
  revenue_usd: Type.Number(),
});
export type AnalyticsTimeseriesPoint = Static<typeof AnalyticsTimeseriesPointSchema>;

export const AnalyticsTimeseriesResponseSchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
  region: Type.Union([Type.String(), Type.Null()]),
  // Dense: every day in the range is present, zero-filled where nothing happened. A sparse series
  // would draw a line straight across a dead week as if it were flat activity.
  points: Type.Array(AnalyticsTimeseriesPointSchema),
});
export type AnalyticsTimeseriesResponse = Static<typeof AnalyticsTimeseriesResponseSchema>;

export const AdminRoleSchema = Type.Union([
  Type.Literal('superadmin'),
  Type.Literal('reviewer'),
  Type.Literal('fulfillment'),
  Type.Literal('analyst'),
]);

export const CmsLoginBodySchema = Type.Object({
  email: Type.String({ minLength: 3, maxLength: 254 }),
  password: Type.String({ minLength: 12, maxLength: 128 }),
});
export type CmsLoginBody = Static<typeof CmsLoginBodySchema>;

export const CmsSessionResponseSchema = Type.Object({
  admin_user: Type.Object({
    id: Type.String(),
    email: Type.String(),
    role: Type.String(),
  }),
  csrf_token: Type.String(),
});
export type CmsSessionResponse = Static<typeof CmsSessionResponseSchema>;

export const AdminUserListQuerySchema = Type.Object({
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  status: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  region_id: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type AdminUserListQuery = Static<typeof AdminUserListQuerySchema>;

export const AdminUserSummarySchema = Type.Object({
  id: Type.String(),
  auth_provider: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  country_code: Type.String(),
  region_id: Type.String(),
  status: Type.String(),
  trust_level: Type.Integer(),
  fraud_score: Type.Integer(),
  created_at: Type.String(),
  wallet: Type.Object({
    available_coin: Type.String(),
    pending_coin: Type.String(),
    lifetime_earned: Type.String(),
    lifetime_redeemed: Type.String(),
  }),
  open_flag_count: Type.Integer(),
});
export type AdminUserSummary = Static<typeof AdminUserSummarySchema>;

export const AdminUserListResponseSchema = Type.Object({
  items: Type.Array(AdminUserSummarySchema),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
});
export type AdminUserListResponse = Static<typeof AdminUserListResponseSchema>;

export const AuditLogListQuerySchema = Type.Object({
  actor_id: Type.Optional(Type.String({ minLength: 1 })),
  action: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  target_type: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  target_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type AuditLogListQuery = Static<typeof AuditLogListQuerySchema>;

export const AuditLogEntrySchema = Type.Object({
  id: Type.String(),
  admin_user_id: Type.Union([Type.String(), Type.Null()]),
  action: Type.String(),
  target_type: Type.Union([Type.String(), Type.Null()]),
  target_id: Type.Union([Type.String(), Type.Null()]),
  detail: Type.Unknown(),
  ip: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
});
export type AuditLogEntry = Static<typeof AuditLogEntrySchema>;

export const AuditLogListResponseSchema = Type.Object({
  items: Type.Array(AuditLogEntrySchema),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
});
export type AuditLogListResponse = Static<typeof AuditLogListResponseSchema>;

export const DashboardResponseSchema = Type.Object({
  counts: Type.Object({
    users_total: Type.Integer(),
    redemptions_pending: Type.Integer(),
    fraud_flags_open: Type.Integer(),
    catalog_items_active: Type.Integer(),
  }),
  economy: EconomyAnalyticsResponseSchema,
  // Every configured region, so the dashboard's region filter does not have to borrow the list from
  // an unrelated settings endpoint.
  regions: Type.Array(Type.String()),
  recent_audit_log: Type.Array(AuditLogEntrySchema),
});
export type DashboardResponse = Static<typeof DashboardResponseSchema>;
