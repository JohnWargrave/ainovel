// Lets an operator bypass the offerwall hold per provider. The default preserves the existing
// pending-credit policy for every installed network.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE network_config
      ADD COLUMN credit_immediately BOOLEAN NOT NULL DEFAULT false;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE network_config
      DROP COLUMN IF EXISTS credit_immediately;
  `);
};
