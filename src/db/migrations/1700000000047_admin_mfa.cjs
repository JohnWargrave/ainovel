// Mandatory TOTP for browser CMS login. TOTP secrets are encrypted by the application and backup
// codes are stored only as hashes.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE admin_users
      ADD COLUMN totp_secret_enc TEXT,
      ADD COLUMN totp_enrolled_at TIMESTAMPTZ,
      ADD COLUMN last_totp_step BIGINT;

    CREATE TABLE admin_backup_codes (
      id              UUID PRIMARY KEY,
      admin_user_id   UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      code_hash       TEXT NOT NULL UNIQUE,
      used_at         TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX admin_backup_codes_user_idx ON admin_backup_codes(admin_user_id);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS admin_backup_codes;
    ALTER TABLE admin_users
      DROP COLUMN IF EXISTS last_totp_step,
      DROP COLUMN IF EXISTS totp_enrolled_at,
      DROP COLUMN IF EXISTS totp_secret_enc;
  `);
};
