// Real partner credentials are deployment data. Keep Tapjoy in shadow mode until dashboard test
// callbacks have been reconciled, matching PubScale's existing safe rollout default.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`UPDATE network_config SET shadow_mode = true WHERE network = 'tapjoy';`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`UPDATE network_config SET shadow_mode = false WHERE network = 'tapjoy';`);
};
