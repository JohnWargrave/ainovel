// Flips region_config.features.offerwall.enabled now that Postback Gateway (1.3) ships — the only
// change 1700000000014's seed anticipated needing once this module lands. Can't edit that applied
// migration, so this UPDATEs the JSONB in place instead.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(features, '{offerwall,enabled}', 'true')
    WHERE region_id IN ('VN', 'ROW');
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(features, '{offerwall,enabled}', 'false')
    WHERE region_id IN ('VN', 'ROW');
  `);
};
