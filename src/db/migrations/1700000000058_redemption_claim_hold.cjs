// A redeem request now sits in a hold window before its reward code can be opened. The window is
// counted from the request timestamp, not from fulfillment, so the countdown the user sees starts
// the moment they spend their coins and does not stretch when fulfillment is slow.
// Default DEFAULT now() keeps any writer that predates this column (analytics fixtures, backfills)
// producing immediately-claimable rows instead of failing the insert.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE redemptions
      ADD COLUMN claimable_at TIMESTAMPTZ NOT NULL DEFAULT now();

    -- Rows created before the hold existed stay claimable the moment they are delivered.
    UPDATE redemptions SET claimable_at = created_at;

    CREATE INDEX redemptions_claimable_at_idx
      ON redemptions (claimable_at)
      WHERE claimed_at IS NULL;

    UPDATE region_config
    SET features = jsonb_set(features, '{redemption,claim_hold_hours}', '48', true)
    WHERE features ? 'redemption'
      AND NOT (features -> 'redemption' ? 'claim_hold_hours');
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS redemptions_claimable_at_idx;

    ALTER TABLE redemptions
      DROP COLUMN IF EXISTS claimable_at;

    UPDATE region_config
    SET features = features #- '{redemption,claim_hold_hours}'
    WHERE features ? 'redemption';
  `);
};
