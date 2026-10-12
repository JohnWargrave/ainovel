// Dev-only placeholder secrets — never real network credentials (same spirit as .env.example).
// allowed_ips starts empty: no real Tapjoy/AdGate dashboard IP ranges known yet (no account), and
// integration tests set/override allowed_ips themselves to match app.inject's simulated remoteAddress.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO network_config (network, secret_key, allowed_ips, currency_per_usd, hold_hours, is_active, shadow_mode) VALUES
      ('tapjoy', 'dev-placeholder-tapjoy-secret', '{}'::cidr[], 1000, 48, true, false),
      ('adgate', 'dev-placeholder-adgate-secret', '{}'::cidr[], NULL, 48, true, false);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DELETE FROM network_config WHERE network IN ('tapjoy', 'adgate');`);
};
