// Seeds a starter redemption catalog. `catalog_items` has been empty since migration 7 created it —
// the crawler (07-CATALOG-CRAWLER.md) is meant to fill it but has no source configured yet, so
// GET /catalog and GET /redemptions/catalog return an empty list, leaving the Redeem screen blank and
// the redemption flow untestable end to end.
//
// coin_price is derived, not invented: usd_cost x COIN_PER_USD (10 000, src/lib/economy.ts) plus a
// 15% listing buffer, floored to the nearest 1 000 coin. Keeping that relationship intact matters —
// redemption.service.ts debits coin_price while the economy counters book usd_cost as real cost, so
// an arbitrary price here would quietly distort the backing ratio the economy alerts watch. The
// cheapest item stays at/above the $5 min_redemption_usd the config reports.
//
// usd_cost values are placeholder retail prices for common denominations, NOT quotes from a supplier
// account (none exists yet). Admin can correct them via the admin catalog routes without a redeploy;
// the crawler overwrites them once it has a source.
//
// regions is CHAR(2)[] and therefore holds *country* codes, not region ids — 'ROW' does not fit and
// would be truncated. listCatalog matches either the caller's country code or their region id, so the
// list below is VN plus the SEA/US countries we expect traffic from, plus 'XX' (what resolveRegion
// returns when geoip cannot place an IP — including localhost in tests and dev).

exports.shorthands = undefined;

const REGIONS = "'{VN,XX,US,SG,MY,TH,PH,ID}'::char(2)[]";

// [sku, title, category, face_value, usd_cost, coin_price]
const ITEMS = [
  ['seagm-googleplay-us-5', 'Google Play $5', 'gift_card', '$5', 5.0, 57000],
  ['seagm-googleplay-us-10', 'Google Play $10', 'gift_card', '$10', 10.0, 115000],
  ['seagm-amazon-us-5', 'Amazon $5', 'gift_card', '$5', 5.0, 57000],
  ['seagm-amazon-us-10', 'Amazon $10', 'gift_card', '$10', 10.0, 115000],
  ['seagm-steam-us-10', 'Steam Wallet $10', 'game_card', '$10', 10.0, 115000],
  ['seagm-freefire-310', 'Free Fire 310 Diamonds', 'game_card', '310 Diamonds', 5.0, 57000],
  ['seagm-paypal-us-10', 'PayPal $10', 'paypal', '$10', 10.0, 115000],
  ['seagm-viettel-100k', 'Viettel 100.000d', 'telco', '100.000d', 5.0, 57000],
];

const escape = (value) => value.replace(/'/g, "''");

const VALUES = ITEMS.map(
  ([sku, title, category, faceValue, usdCost, coinPrice]) =>
    `(gen_random_uuid(), '${sku}', '${escape(title)}', '${category}', '${escape(faceValue)}', ` +
    `${usdCost}, ${coinPrice}, ${REGIONS}, true, 'manual')`,
).join(',\n      ');

const SKUS = ITEMS.map(([sku]) => `'${sku}'`).join(', ');

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO catalog_items
      (id, sku, title, category, face_value, usd_cost, coin_price, regions, is_active, source)
    VALUES
      ${VALUES}
    ON CONFLICT (sku) DO NOTHING;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  // Only the seeded SKUs, and only those never redeemed against — a redemption holds an FK to
  // catalog_items and its coin_price snapshot is the user's receipt.
  pgm.sql(`
    DELETE FROM catalog_items
    WHERE sku IN (${SKUS})
      AND id NOT IN (SELECT catalog_item_id FROM redemptions);
  `);
};
