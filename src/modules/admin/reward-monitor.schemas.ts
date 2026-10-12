import { Type, type Static } from '@sinclair/typebox';

export const RewardMonitorNetworkSchema = Type.Union([
  Type.Literal('tapjoy'),
  Type.Literal('pubscale'),
]);
export type RewardMonitorNetwork = Static<typeof RewardMonitorNetworkSchema>;

export const RewardMonitorParamsSchema = Type.Object({
  network: RewardMonitorNetworkSchema,
});
export type RewardMonitorParams = Static<typeof RewardMonitorParamsSchema>;

const UuidString = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});

export const RewardMonitorQuerySchema = Type.Object({
  window_hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
  user_id: Type.Optional(UuidString),
  transaction_id: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  cursor: Type.Optional(UuidString),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type RewardMonitorQuery = Static<typeof RewardMonitorQuerySchema>;

const NullableString = Type.Union([Type.String(), Type.Null()]);

export const RewardMonitorResponseSchema = Type.Object({
  network: RewardMonitorNetworkSchema,
  from: Type.String(),
  to: Type.String(),
  summary: Type.Object({
    callbacks_received: Type.Integer(),
    callbacks_not_credited: Type.Integer(),
    rewards_credited: Type.Integer(),
    coins_credited: Type.String(),
    unique_users: Type.Integer(),
    latest_credit_at: NullableString,
  }),
  rewards: Type.Array(
    Type.Object({
      id: Type.String(),
      created_at: Type.String(),
      user_id: Type.String(),
      transaction_id: NullableString,
      payout_usd: NullableString,
      coins_awarded: Type.String(),
      share_applied: NullableString,
      status: Type.String(),
      bucket: Type.String(),
      available_balance_after: Type.String(),
      hold_until: NullableString,
    }),
  ),
  next_cursor: NullableString,
  recent_callbacks: Type.Array(
    Type.Object({
      id: Type.String(),
      created_at: Type.String(),
      verdict: Type.String(),
      user_id: NullableString,
      transaction_id: NullableString,
      earning_event_id: NullableString,
    }),
  ),
});
export type RewardMonitorResponse = Static<typeof RewardMonitorResponseSchema>;
