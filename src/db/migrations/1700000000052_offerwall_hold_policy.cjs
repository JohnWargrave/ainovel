// Makes the high-value offerwall hold policy provider-configurable. Existing behavior is preserved:
// payouts above $5 use a 72-hour hold, while all other payouts use hold_hours (normally 48).

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE network_config
      ADD COLUMN high_value_threshold_usd NUMERIC(12,4) NOT NULL DEFAULT 5,
      ADD COLUMN high_value_hold_hours SMALLINT NOT NULL DEFAULT 72;

    UPDATE network_config
    SET high_value_hold_hours = GREATEST(hold_hours, 72);

    ALTER TABLE network_config
      ADD CONSTRAINT network_config_hold_policy_check CHECK (
        hold_hours >= 0
        AND high_value_threshold_usd > 0
        AND high_value_hold_hours >= hold_hours
        AND high_value_hold_hours BETWEEN 0 AND 720
      );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE network_config
      DROP CONSTRAINT IF EXISTS network_config_hold_policy_check,
      DROP COLUMN IF EXISTS high_value_hold_hours,
      DROP COLUMN IF EXISTS high_value_threshold_usd;
  `);
};
