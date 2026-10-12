// Mirrors 02-DATABASE-SCHEMA.md §5. Created before users (users.region_id FK → region_config).

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE region_config (
      region_id     TEXT PRIMARY KEY,            -- 'VN','ID','TH','ROW'(rest of world)...
      countries     CHAR(2)[] NOT NULL,          -- map country → region
      features      JSONB NOT NULL,
      -- {
      --   "drama":        {"enabled": true, "catalog_region": "VN", "interstitial_every": 2, "episode_reward_daily_cap": 20},
      --   "spin":         {"enabled": true, "table_id": "<spin_config.id>"},
      --   "offerwall":    {"networks": ["tapjoy","adgate"], "shares": {"0":0.30,"1":0.35,"2":0.40,"3":0.50}},
      --   "rewarded_ads": {"daily_cap": 20, "coin_cap": 50, "cooldown_s": 30},
      --   "checkin":      {"rewards": [10,15,20,25,30,40,100]},
      --   "redemption":   {"weekly_cap_usd": {"0":2,"1":5,"2":15,"3":50}}
      -- }
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS region_config;`);
};
