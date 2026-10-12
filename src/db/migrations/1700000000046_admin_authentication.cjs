// Individual CMS credentials and opaque, server-revocable sessions. Existing admin rows remain but
// cannot use the browser CMS until a password hash is provisioned.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX admin_users_email_case_insensitive
      ON admin_users(lower(email));

    ALTER TABLE admin_users
      ADD COLUMN password_hash TEXT,
      ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
      ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN locked_until TIMESTAMPTZ,
      ADD COLUMN password_changed_at TIMESTAMPTZ,
      ADD COLUMN last_login_at TIMESTAMPTZ;

    CREATE TABLE admin_sessions (
      id              UUID PRIMARY KEY,
      admin_user_id   UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      token_hash      TEXT NOT NULL UNIQUE,
      csrf_hash       TEXT NOT NULL,
      expires_at      TIMESTAMPTZ NOT NULL,
      revoked_at      TIMESTAMPTZ,
      ip              INET,
      user_agent      TEXT,
      last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX admin_sessions_user_idx ON admin_sessions(admin_user_id, created_at DESC);
    CREATE INDEX admin_sessions_active_idx ON admin_sessions(expires_at)
      WHERE revoked_at IS NULL;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS admin_sessions;
    ALTER TABLE admin_users
      DROP COLUMN IF EXISTS last_login_at,
      DROP COLUMN IF EXISTS password_changed_at,
      DROP COLUMN IF EXISTS locked_until,
      DROP COLUMN IF EXISTS failed_login_count,
      DROP COLUMN IF EXISTS status,
      DROP COLUMN IF EXISTS password_hash;
    DROP INDEX IF EXISTS admin_users_email_case_insensitive;
  `);
};
