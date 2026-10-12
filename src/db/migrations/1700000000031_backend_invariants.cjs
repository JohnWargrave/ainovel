// Backend correctness and query-shape hardening. These are deliberately additive so the migration
// can be applied after the original milestone migrations without rewriting ledger history.
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE coin_ledger
      ADD CONSTRAINT coin_ledger_amount_nonzero CHECK (amount <> 0),
      ADD CONSTRAINT coin_ledger_bucket_valid CHECK (bucket IN ('available', 'pending'));
    ALTER TABLE wallets
      ADD CONSTRAINT wallets_lifetime_earned_nonnegative CHECK (lifetime_earned >= 0),
      ADD CONSTRAINT wallets_lifetime_redeemed_nonnegative CHECK (lifetime_redeemed >= 0),
      ADD CONSTRAINT wallets_revenue_nonnegative CHECK (lifetime_revenue_usd >= 0);
    CREATE UNIQUE INDEX earning_events_network_tx_unique
      ON earning_events (source, network_tx_id) WHERE network_tx_id IS NOT NULL;
    CREATE INDEX earning_events_user_created_idx ON earning_events (user_id, created_at DESC);
    CREATE INDEX postback_logs_network_created_idx ON postback_logs (network, created_at DESC);
    CREATE INDEX watch_sessions_user_episode_idx ON watch_sessions (user_id, episode_id);
    CREATE INDEX drama_series_live_region_idx ON drama_series USING GIN (license_regions) WHERE status = 'live';
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS drama_series_live_region_idx;
    DROP INDEX IF EXISTS watch_sessions_user_episode_idx;
    DROP INDEX IF EXISTS postback_logs_network_created_idx;
    DROP INDEX IF EXISTS earning_events_user_created_idx;
    DROP INDEX IF EXISTS earning_events_network_tx_unique;
    ALTER TABLE wallets
      DROP CONSTRAINT IF EXISTS wallets_revenue_nonnegative,
      DROP CONSTRAINT IF EXISTS wallets_lifetime_redeemed_nonnegative,
      DROP CONSTRAINT IF EXISTS wallets_lifetime_earned_nonnegative;
    ALTER TABLE coin_ledger
      DROP CONSTRAINT IF EXISTS coin_ledger_pending_has_hold,
      DROP CONSTRAINT IF EXISTS coin_ledger_bucket_valid,
      DROP CONSTRAINT IF EXISTS coin_ledger_amount_nonzero;
  `);
};
