// 07-CATALOG-CRAWLER.md §3: FX MYR->USD rate, updated by hand weekly (or a feed later). Single-row
// key/value table rather than a hardcoded constant since it's admin-editable business data, mirroring
// network_config's per-key row shape.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE fx_rates (
      currency_pair TEXT PRIMARY KEY,        -- 'MYR_USD'
      rate          NUMERIC(12,6) NOT NULL,  -- 1 unit of the first currency = rate units of the second
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO fx_rates (currency_pair, rate) VALUES ('MYR_USD', 0.21);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS fx_rates;`);
};
