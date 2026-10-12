// Phase 1 Milestone A deltas on top of the Phase 0 schema (see ainovel-design-v1_1 backend_doing.md):
// - wallets.lifetime_revenue_usd: 14-USER-JOURNEY-ECONOMY.md §3 flags this as a required addition for
//   invariant I4 (profit gate) and I6 (backing ratio) — not present in the original 02-DATABASE-SCHEMA.md.
// - coin_ledger.hold_until: the schema doc describes the pending->available hold-release mechanism in prose
//   only, without a column to query by. Adding it so the HOLD_RELEASE job can index-scan due entries instead
//   of re-deriving the deadline from a join on every run.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE wallets ADD COLUMN lifetime_revenue_usd NUMERIC(12,4) NOT NULL DEFAULT 0;
    ALTER TABLE coin_ledger ADD COLUMN hold_until TIMESTAMPTZ;
    CREATE INDEX coin_ledger_pending_hold_idx ON coin_ledger (hold_until)
      WHERE bucket = 'pending' AND hold_until IS NOT NULL;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS coin_ledger_pending_hold_idx;
    ALTER TABLE coin_ledger DROP COLUMN IF EXISTS hold_until;
    ALTER TABLE wallets DROP COLUMN IF EXISTS lifetime_revenue_usd;
  `);
};
