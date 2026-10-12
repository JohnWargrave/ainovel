// The catalog minimum is $5, so the original $2 L0 weekly cap made every redemption impossible.
// Only migrate the original seeded value; preserve any region already customized by an admin.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(features, '{redemption,weekly_cap_usd,0}', '5', false)
    WHERE features #>> '{redemption,weekly_cap_usd,0}' = '2';
  `);
};

// Deliberately irreversible: changing every $5 cap back to $2 could overwrite a later CMS edit.
exports.down = () => {};
