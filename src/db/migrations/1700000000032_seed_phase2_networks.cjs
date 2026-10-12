// Phase 2 networks start in shadow mode. Credentials and the exact signed field template are
// deployment data; no placeholder can safely be promoted to live crediting.
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO network_config (network, secret_key, allowed_ips, currency_per_usd, hold_hours, is_active, shadow_mode)
    VALUES
      ('adjoe', 'dev-placeholder-adjoe-secret', '{}'::cidr[], 1, 48, true, true),
      ('appsprize', 'dev-placeholder-appsprize-secret', '{}'::cidr[], 1, 48, true, true)
    ON CONFLICT (network) DO NOTHING;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DELETE FROM network_config WHERE network IN ('adjoe', 'appsprize');`);
};
