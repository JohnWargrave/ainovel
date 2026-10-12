// 1700000000014 seeded region_config.features.rewarded_ads without an eCPM input (01-COIN-ECONOMY.md
// §2.2's estimated_ecpm(geo) has no data source anywhere in the doc set — Drama's reconciliation-based
// est_ecpm is Phase 3, unbuilt). Adds a static, admin-editable est_ecpm_usd instead, and flips
// `enabled` now that this module ships — same pattern as 1700000000017 for offerwall.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(features, '{rewarded_ads,est_ecpm_usd}', '2.5')
    WHERE region_id = 'VN';

    UPDATE region_config
    SET features = jsonb_set(features, '{rewarded_ads,est_ecpm_usd}', '5.0')
    WHERE region_id = 'ROW';

    UPDATE region_config
    SET features = jsonb_set(features, '{rewarded_ads,enabled}', 'true')
    WHERE region_id IN ('VN', 'ROW');
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(features, '{rewarded_ads,enabled}', 'false')
    WHERE region_id IN ('VN', 'ROW');
  `);
};
