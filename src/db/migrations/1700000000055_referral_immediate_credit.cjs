// Makes the referral credit destination explicit per region while preserving existing hold behavior.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(features, '{referral,credit_immediately}', 'false', true)
    WHERE features ? 'referral';
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = features #- '{referral,credit_immediately}'
    WHERE features ? 'referral';
  `);
};
