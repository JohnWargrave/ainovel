/** @type {import('node-pg-migrate').Shorthands | undefined} */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // pgcrypto: dùng để encrypt delivery_code at rest (12 §3), xem 02-DATABASE-SCHEMA.md §4.
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP EXTENSION IF EXISTS pgcrypto;`);
};
