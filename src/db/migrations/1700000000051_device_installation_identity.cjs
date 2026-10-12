// Guest authentication uses the app installation UUID from X-Device-Id. Existing device rows stay
// nullable until a legacy guest returns and is migrated by the auth service.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE devices ADD COLUMN installation_id UUID;
    CREATE UNIQUE INDEX devices_installation_id_unique
      ON devices (installation_id)
      WHERE installation_id IS NOT NULL;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS devices_installation_id_unique;
    ALTER TABLE devices DROP COLUMN IF EXISTS installation_id;
  `);
};
