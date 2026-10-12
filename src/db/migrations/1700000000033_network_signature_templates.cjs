exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE network_config
      ADD COLUMN signature_format TEXT NOT NULL DEFAULT 'hmac-sha256',
      ADD COLUMN signature_fields TEXT[] NOT NULL DEFAULT ARRAY['transaction_id', 'user_id', 'payout_usd'],
      ADD COLUMN signature_param TEXT NOT NULL DEFAULT 'signature',
      ADD COLUMN reversal_values TEXT[] NOT NULL DEFAULT ARRAY['reversal', 'chargeback', 'cancelled'];
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE network_config
      DROP COLUMN IF EXISTS reversal_values,
      DROP COLUMN IF EXISTS signature_param,
      DROP COLUMN IF EXISTS signature_fields,
      DROP COLUMN IF EXISTS signature_format;
  `);
};
