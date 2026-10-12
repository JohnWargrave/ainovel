// PubScale offerwall network row. Ships with shadow_mode = true per 15§7's rollout rule: the verifier
// logs its verdict against real traffic without crediting, so the signature formula and payout math
// can be diffed against the PubScale dashboard before any coin is minted.
//
// allowed_ips are the three callback source addresses published in PubScale's S2S docs (last updated
// 2026-01-20 there). They're documented as subject to change, so the weekly ip-allowlist-refresh job
// flagging drift into audit_log applies here too.
//
// currency_per_usd = 1000 matches the Tapjoy row and must equal the reward exchange rate configured
// in the PubScale dashboard ($1 = 1000). It also bounds the tamper window created by PubScale hashing
// only the integer part of `value`: at 1000, one unit is $0.001.
//
// secret_key is a placeholder — the real key is provided alongside the app API key and is set
// directly in the deployment's database, never committed.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO network_config (network, secret_key, allowed_ips, currency_per_usd, hold_hours, is_active, shadow_mode)
    VALUES (
      'pubscale',
      'dev-placeholder-pubscale-secret',
      '{34.100.236.68/32,34.100.128.195/32,34.14.172.7/32}'::cidr[],
      1000,
      48,
      true,
      true
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DELETE FROM network_config WHERE network = 'pubscale';`);
};
