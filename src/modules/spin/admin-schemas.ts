import { Type, type Static } from '@sinclair/typebox';

// spin_config.daily_cap is SMALLINT; 1000 keeps a fat headroom under 32767 while still reading as a
// number a human meant to type.
export const SPIN_DAILY_CAP_MAX = 1000;
// A wheel the app can draw: it renders one segment per prize.
export const SPIN_PRIZES_MAX = 12;

// What the CMS edits. Vouchers are left out on purpose: the spin cannot award one yet
// (SPIN_PRIZE_UNSUPPORTED), so a table carrying one would break spins.
export const SpinPrizeAdminSchema = Type.Object({
  slot: Type.Integer({ minimum: 1, maximum: SPIN_PRIZES_MAX }),
  type: Type.Union([Type.Literal('coin'), Type.Literal('boost')]),
  // Coin amount (integer) for coin, "multiplier x minutes" (e.g. "2x60") for boost. Unknown here so
  // the coercing validator cannot turn one into the other; validatePrizeTable checks it per type.
  value: Type.Unknown(),
  // Relative odds: a prize's chance is its weight over the sum of all weights.
  weight: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  tier: Type.Union([
    Type.Literal('low'),
    Type.Literal('mid'),
    Type.Literal('high'),
    Type.Literal('jackpot'),
  ]),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
});
export type SpinPrizeAdmin = Static<typeof SpinPrizeAdminSchema>;

const SpinConfigRegionUsageSchema = Type.Object({
  region_id: Type.String(),
  // 'paid' = features.spin.table_id, 'free' = features.spin.free_table_id. daily_cap only gates the
  // paid table; the free table is one spin per day regardless of what this value says.
  role: Type.Union([Type.Literal('paid'), Type.Literal('free')]),
});

export const SpinConfigAdminSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  // "0" on every active table since spins became ad-funded. Read-only here; it is retained only so
  // the CMS can show that no coin is charged.
  ticket_coin: Type.String(),
  // Ceiling on the paid table's expected value. Replaced the old ticket_coin * 0.95 rule, which is
  // meaningless once the ticket is 0. Surfaced read-only: changing it changes payout economics, so
  // it is a migration-level decision, not a form field.
  max_ev_coin: Type.String(),
  daily_cap: Type.Integer(),
  is_active: Type.Boolean(),
  used_by: Type.Array(SpinConfigRegionUsageSchema),
  prizes: Type.Array(
    Type.Object({
      slot: Type.Integer(),
      type: Type.String(),
      value: Type.Union([Type.Integer(), Type.String()]),
      weight: Type.Integer(),
      tier: Type.String(),
      label: Type.Union([Type.Null(), Type.String()]),
    }),
  ),
  // Average coin paid per spin under the current prizes (boosts count as 0), and the band the
  // server enforces for the roles this table plays: max_ev_coin for paid, a fixed band for free.
  ev_coin: Type.Number(),
  ev_min: Type.Union([Type.Null(), Type.Number()]),
  ev_max: Type.Number(),
  updated_at: Type.String(),
});
export type SpinConfigAdmin = Static<typeof SpinConfigAdminSchema>;

export const SpinConfigListResponseSchema = Type.Object({
  items: Type.Array(SpinConfigAdminSchema),
});

export const UpdateSpinConfigSchema = Type.Object(
  {
    daily_cap: Type.Optional(Type.Integer({ minimum: 1, maximum: SPIN_DAILY_CAP_MAX })),
    // Replaces the whole table.
    prizes: Type.Optional(
      Type.Array(SpinPrizeAdminSchema, { minItems: 1, maxItems: SPIN_PRIZES_MAX }),
    ),
  },
  { minProperties: 1 },
);
export type UpdateSpinConfig = Static<typeof UpdateSpinConfigSchema>;
