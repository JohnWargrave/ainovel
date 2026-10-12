// Enable check-in feature for VN and ROW regions.
// The feature config key was seeded in 1700000000014_seed_region_config.cjs with enabled:false.
// All other checkin fields (rewards array) are already present in the seed.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(features, '{checkin,enabled}', 'true')
    WHERE region_id IN ('VN', 'ROW');
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(features, '{checkin,enabled}', 'false')
    WHERE region_id IN ('VN', 'ROW');
  `);
};
