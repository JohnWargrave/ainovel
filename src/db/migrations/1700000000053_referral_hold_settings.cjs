// Referral rewards historically mirrored only the source earning event's hold. This explicit
// region setting lets operations impose an additional minimum wait without shortening that source
// hold. Zero preserves the previous behavior.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(features, '{referral,hold_hours}', '0', true)
    WHERE features ? 'referral';

    UPDATE coin_ledger credit
    SET hold_until = NULL
    WHERE credit.entry_type = 'REFERRAL_CREDIT'
      AND credit.bucket = 'pending'
      AND credit.hold_until IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM coin_ledger clawback
        WHERE clawback.user_id = credit.user_id
          AND clawback.entry_type = 'REFERRAL_CLAWBACK'
          AND clawback.ref_type = credit.ref_type
          AND clawback.ref_id = credit.ref_id
      );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = features #- '{referral,hold_hours}'
    WHERE features ? 'referral';
  `);
};
