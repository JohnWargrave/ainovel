// Flips region_config.features.referral.enabled now that Referral Core (2.2) has implementation +
// integration test coverage — mirrors 1700000000017/19/20/21's "seed disabled, enable once the module
// ships" pattern. RF01-RF04 anti-abuse and the invariant cap are enforced regardless of this flag;
// this only controls whether processReferralCredit actually mints REFERRAL_CREDIT for the region.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE region_config SET features = jsonb_set(features, '{referral,enabled}', 'true')
    WHERE region_id IN ('VN', 'ROW');
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config SET features = jsonb_set(features, '{referral,enabled}', 'false')
    WHERE region_id IN ('VN', 'ROW');
  `);
};
