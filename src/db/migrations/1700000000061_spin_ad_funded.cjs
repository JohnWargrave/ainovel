// Lucky Spin becomes ad-funded: every spin, free or paid, is paid for by a rewarded ad instead of a
// 100-coin ticket. Three things have to change together or the feature breaks:
//
// 1. `spin_history_id` on the intent — proof that a given ad has already been spent on a spin. The
//    partial unique index, not the application check, is what actually makes an intent single-use:
//    two concurrent POST /spin calls with the same intent_id both pass a SELECT but only one can win
//    the index.
//
// 2. `max_ev_coin` on spin_config — validatePrizeTable() bounds the paid table's expected value at
//    `ticket_coin * 0.95`. With ticket_coin going to 0 that bound becomes `ev >= 0`, which every
//    non-empty prize table fails, and every paid spin would 500 on SPIN_CONFIG_EV_INVALID. The
//    backfill preserves each table's current effective ceiling, so this migration changes no
//    existing validation outcome.
//
// 3. ticket_coin -> 0 on the active paid table. Kept as a column (and still reported by /spin/state
//    and /config as "0") rather than dropped, so clients that read the field keep parsing.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE rewarded_ad_intents
      ADD COLUMN spin_history_id UUID REFERENCES spin_history(id);

    CREATE UNIQUE INDEX rewarded_ad_intents_spin_history_uniq
      ON rewarded_ad_intents(spin_history_id)
      WHERE spin_history_id IS NOT NULL;

    ALTER TABLE spin_config
      ADD COLUMN max_ev_coin BIGINT;

    UPDATE spin_config
    SET max_ev_coin = GREATEST(FLOOR(ticket_coin * 0.95), 50);

    ALTER TABLE spin_config
      ALTER COLUMN max_ev_coin SET NOT NULL,
      ALTER COLUMN max_ev_coin SET DEFAULT 50;

    UPDATE spin_config
    SET ticket_coin = 0, updated_at = now()
    WHERE is_active = true;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  // ticket_coin is deliberately not restored: the original per-table value is not recoverable from
  // max_ev_coin (the backfill floors at 50), and guessing one would start charging users coin again.
  pgm.sql(`
    ALTER TABLE spin_config DROP COLUMN IF EXISTS max_ev_coin;

    DROP INDEX IF EXISTS rewarded_ad_intents_spin_history_uniq;
    ALTER TABLE rewarded_ad_intents DROP COLUMN IF EXISTS spin_history_id;
  `);
};
