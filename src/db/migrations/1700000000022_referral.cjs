// 11-REFERRAL.md §2: referred_by is set once at redeem time (72h window, immutable — enforced in app
// logic, not a DB constraint) and needs a timestamp for the window/duration checks; referred_ip is the
// only IP capture point that exists for RF02's same-/24 clustering; referral_qualified_at marks the
// point (Play Integrity pass + first backed offer >= $0.10) after which REFERRAL_CREDIT starts flowing.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN referred_by_set_at TIMESTAMPTZ NULL,
      ADD COLUMN referred_ip INET NULL,
      ADD COLUMN referral_qualified_at TIMESTAMPTZ NULL;

    CREATE INDEX users_referred_by_idx ON users(referred_by) WHERE referred_by IS NOT NULL;

    UPDATE region_config
    SET features = jsonb_set(
      features, '{referral}',
      jsonb_build_object(
        'enabled', false,
        'pct', 0.10,
        'duration_months', null,
        'milestone_bonus_coin', 2000,
        'milestone_bonus_threshold', 50000
      )
    )
    WHERE region_id IN ('VN', 'ROW');
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config SET features = features - 'referral' WHERE region_id IN ('VN', 'ROW');
    DROP INDEX IF EXISTS users_referred_by_idx;
    ALTER TABLE users
      DROP COLUMN IF EXISTS referral_qualified_at,
      DROP COLUMN IF EXISTS referred_ip,
      DROP COLUMN IF EXISTS referred_by_set_at;
  `);
};
