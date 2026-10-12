// Tapjoy callback source IPs, from the official self-managed currency docs
// (docs.unity.com/en-us/grow/offerwall/monetization/virtual-currency/self-managed-currency —
// Tapjoy is under Unity/ironSource now). The page states the list is accurate as of 2024-05-12.
//
// Until now this row had allowed_ips = '{}' (1700000000016_seed_network_config.cjs: "no real Tapjoy
// dashboard IP ranges known yet"), and isIpAllowed() treats an empty list as deny-all — so every
// signature-valid Tapjoy postback was quarantined and credited nothing. This is the row that unblocks
// live Tapjoy traffic.
//
// Stored as /32 because Tapjoy publishes individual addresses, not ranges. The docs warn the list can
// change, and the weekly ip-allowlist-refresh job has no automated source for Tapjoy
// (noopIpRangeSource) — so drift here surfaces as `quarantined` verdicts in postback_logs, not as an
// automatic update. Check postback_logs.remote_ip when quarantines appear.

exports.shorthands = undefined;

const TAPJOY_CALLBACK_IPS = [
  '18.215.207.89/32',
  '18.235.142.165/32',
  '23.20.255.113/32',
  '23.23.134.165/32',
  '3.210.188.32/32',
  '3.215.42.140/32',
  '3.217.209.177/32',
  '3.218.95.35/32',
  '3.219.236.53/32',
  '3.231.137.161/32',
];

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE network_config
    SET allowed_ips = '{${TAPJOY_CALLBACK_IPS.join(',')}}'::cidr[]
    WHERE network = 'tapjoy';
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`UPDATE network_config SET allowed_ips = '{}'::cidr[] WHERE network = 'tapjoy';`);
};
