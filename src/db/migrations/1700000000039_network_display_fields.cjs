// Display metadata for offerwall networks, moved out of the hardcoded NETWORK_META map in
// src/modules/earning/offerwall.service.ts and into the row that already defines each network.
//
// Why the app needs this: Tapjoy and PubScale are opened through their Android SDK with a placement
// name, not by navigating to a URL. GET /offerwall/offers was returning `deeplink_url: ""` and
// `icon_url: null` for every network, so the app had a tile it could neither label with a logo nor
// act on. `placement` is the missing piece — it is what the SDK's showOfferwall(placement) call
// needs.
//
// Values are NULL until the real ones are on hand (no partner dashboard access yet). NULL is the
// honest answer and the app falls back to its bundled asset; a fabricated CDN URL would render as a
// broken image, and a guessed placement would fail inside the SDK with no useful error. Filling them
// in later is an UPDATE, not a redeploy — same reasoning as the rest of network_config.
//
// Deliberately NOT added here: a per-offer list. That requires each network's offer API and
// credentials we do not have; the SDK renders the offers itself.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE network_config
      ADD COLUMN display_name TEXT,
      ADD COLUMN icon_url     TEXT,
      ADD COLUMN placement    TEXT;

    UPDATE network_config SET display_name = 'Tapjoy'      WHERE network = 'tapjoy';
    UPDATE network_config SET display_name = 'PubScale'    WHERE network = 'pubscale';
    UPDATE network_config SET display_name = 'AdGate Media' WHERE network = 'adgate';
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE network_config
      DROP COLUMN display_name,
      DROP COLUMN icon_url,
      DROP COLUMN placement;
  `);
};
