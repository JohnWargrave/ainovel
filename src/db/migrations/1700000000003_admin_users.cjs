// Mirrors 02-DATABASE-SCHEMA.md §8 (admin_users only). Created before users/redemptions
// which reference it (users has no FK to admin_users, but redemptions.reviewed_by does).

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE admin_users (
      id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,                        -- superadmin|reviewer|fulfillment|analyst
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS admin_users;`);
};
