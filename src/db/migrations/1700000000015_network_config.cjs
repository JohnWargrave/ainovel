// Mirrors 04-POSTBACK-SPEC.md §8, plus shadow_mode column for 15-SCALE-RELIABILITY.md §7.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE network_config (
      network          TEXT PRIMARY KEY,       -- 'tapjoy'|'adgate' this milestone; more in Phase 2
      secret_key       TEXT NOT NULL,
      allowed_ips      CIDR[] NOT NULL DEFAULT '{}',
      currency_per_usd NUMERIC(12,4),          -- non-null when network pays in virtual currency (Tapjoy)
      hold_hours       SMALLINT NOT NULL DEFAULT 48,
      is_active        BOOLEAN NOT NULL DEFAULT true,
      shadow_mode      BOOLEAN NOT NULL DEFAULT false,  -- 15§7: verify+compute but skip the real credit
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS network_config;`);
};
