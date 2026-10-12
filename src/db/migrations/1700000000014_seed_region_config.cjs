// region_config was empty after Phase 0 (no admin UI yet to populate it), but users.region_id is NOT NULL with
// a FK to region_config — signup needs at least one resolvable row. Seeds the two regions already anticipated
// by the region_config migration's own comment ('VN' and 'ROW' = rest-of-world fallback for any country not
// explicitly mapped). Feature flags default to `enabled: false` for modules not built yet in this milestone
// (offerwall/rewarded_ads/checkin/spin/drama/redemption) — the numeric defaults (rates, caps) already match
// 01-COIN-ECONOMY.md/03-API-CONTRACT.md so flipping `enabled: true` later (via the admin region-config
// endpoint, out of scope here) is the only change needed once each module ships.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  const features = {
    drama: { enabled: false, catalog_region: 'VN', interstitial_every: 2, episode_reward_daily_cap: 20 },
    spin: { enabled: false, table_id: null },
    offerwall: { enabled: false, networks: ['tapjoy', 'adgate'], shares: { '0': 0.3, '1': 0.35, '2': 0.4, '3': 0.5 } },
    rewarded_ads: { enabled: false, daily_cap: 20, coin_cap: 50, cooldown_s: 30 },
    checkin: { enabled: false, rewards: [10, 15, 20, 25, 30, 40, 100] },
    redemption: { enabled: false, weekly_cap_usd: { '0': 2, '1': 5, '2': 15, '3': 50 } },
  };

  pgm.sql(`
    INSERT INTO region_config (region_id, countries, features) VALUES
      ('VN', ARRAY['VN']::CHAR(2)[], '${JSON.stringify(features)}'::jsonb),
      ('ROW', ARRAY[]::CHAR(2)[], '${JSON.stringify(features)}'::jsonb);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DELETE FROM region_config WHERE region_id IN ('VN', 'ROW');`);
};
