// Settings for POST /earning/coin — the one endpoint where the client names its own coin amount.
//
// `enabled` defaults to FALSE. A feature that mints coin on the client's word has to be switched on
// deliberately by a superadmin, not inherited by every environment that runs the migration.
//
// `max_amount_coin` is not optional decoration: without a per-request ceiling the only thing between
// a tampered client and an arbitrary balance is the I2 rolling cap, which is a 30-day aggregate and
// would happily pass a single 20,000-coin request. The default of 1000 is deliberately small — raise
// it in the CMS once you know what the real per-grant amount should be.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE direct_coin_settings (
      id               TEXT PRIMARY KEY CHECK (id = 'global'),
      enabled          BOOLEAN NOT NULL DEFAULT false,
      max_amount_coin  INTEGER NOT NULL DEFAULT 1000
        CHECK (max_amount_coin BETWEEN 1 AND 10000000),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO direct_coin_settings (id, enabled, max_amount_coin)
    VALUES ('global', false, 1000);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS direct_coin_settings;`);
};
