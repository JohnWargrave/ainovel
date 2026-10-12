// Captures the *client's* request context at intent time so it can be copied onto earning_events when
// the SSV callback credits. Necessary because an AdMob SSV callback is server-to-server: the remote IP
// on that request is Google's, not the user's, so populating earning_events.ip_at_event from the
// callback would poison the fraud engine's IP signals (05-FRAUD-ENGINE.md N01–N03) rather than feed
// them. The intent request, by contrast, comes straight from the app over an authenticated route.
//
// Nullable and backfill-free: rows created before this migration simply keep NULL, which is what
// earning_events already stored for every rewarded-ad event to date.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE rewarded_ad_intents
      ADD COLUMN ip_at_intent  INET,
      ADD COLUMN geo_at_intent CHAR(2);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE rewarded_ad_intents
      DROP COLUMN IF EXISTS geo_at_intent,
      DROP COLUMN IF EXISTS ip_at_intent;
  `);
};
