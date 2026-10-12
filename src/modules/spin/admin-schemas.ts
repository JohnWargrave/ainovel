import { Type, type Static } from '@sinclair/typebox';

// spin_config.daily_cap is SMALLINT; 1000 keeps a fat headroom under 32767 while still reading as a
// number a human meant to type.
export const SPIN_DAILY_CAP_MAX = 1000;

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
  updated_at: Type.String(),
});
export type SpinConfigAdmin = Static<typeof SpinConfigAdminSchema>;

export const SpinConfigListResponseSchema = Type.Object({
  items: Type.Array(SpinConfigAdminSchema),
});

export const UpdateSpinConfigSchema = Type.Object({
  daily_cap: Type.Integer({ minimum: 1, maximum: SPIN_DAILY_CAP_MAX }),
});
export type UpdateSpinConfig = Static<typeof UpdateSpinConfigSchema>;
