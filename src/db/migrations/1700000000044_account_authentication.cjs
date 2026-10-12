// Multiple login methods per stable user, password recovery, authentication history, and
// server-revocable client sessions. Existing users.auth_provider/auth_subject columns remain as a
// compatibility summary while callers migrate to user_identities/password_credentials.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE user_identities (
      id                  UUID PRIMARY KEY,
      user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider            TEXT NOT NULL CHECK (provider IN ('guest', 'google', 'facebook')),
      provider_subject    TEXT NOT NULL,
      email               TEXT,
      email_verified_at   TIMESTAMPTZ,
      last_used_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      disabled_at         TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_subject)
    );
    CREATE INDEX user_identities_user_idx ON user_identities(user_id);

    INSERT INTO user_identities (
      id, user_id, provider, provider_subject, email, email_verified_at, last_used_at, created_at
    )
    SELECT
      gen_random_uuid(), id, auth_provider, auth_subject, email,
      CASE WHEN auth_provider IN ('google', 'facebook') AND email IS NOT NULL THEN created_at END,
      updated_at, created_at
    FROM users
    WHERE auth_provider IN ('guest', 'google', 'facebook')
    ON CONFLICT (provider, provider_subject) DO NOTHING;

    CREATE TABLE password_credentials (
      user_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      username              TEXT NOT NULL,
      email                 TEXT NOT NULL,
      password_hash         TEXT NOT NULL,
      email_verified_at     TIMESTAMPTZ,
      password_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      disabled_at           TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX password_credentials_username_unique
      ON password_credentials(lower(username));
    CREATE UNIQUE INDEX password_credentials_email_unique
      ON password_credentials(lower(email));

    CREATE TABLE auth_events (
      id             UUID PRIMARY KEY,
      user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
      provider       TEXT NOT NULL,
      event_type     TEXT NOT NULL,
      outcome        TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
      failure_code   TEXT,
      ip             INET,
      user_agent     TEXT,
      device_id      TEXT,
      metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX auth_events_user_created_idx ON auth_events(user_id, created_at DESC);
    CREATE INDEX auth_events_created_idx ON auth_events(created_at DESC);

    CREATE TABLE password_reset_tokens (
      id          UUID PRIMARY KEY,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX password_reset_tokens_user_idx
      ON password_reset_tokens(user_id, created_at DESC);

    CREATE TABLE email_verification_tokens (
      id          UUID PRIMARY KEY,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX email_verification_tokens_user_idx
      ON email_verification_tokens(user_id, created_at DESC);

    ALTER TABLE refresh_tokens
      ADD COLUMN session_id UUID,
      ADD COLUMN device_id TEXT,
      ADD COLUMN ip INET,
      ADD COLUMN user_agent TEXT,
      ADD COLUMN last_used_at TIMESTAMPTZ,
      ADD COLUMN session_started_at TIMESTAMPTZ,
      ADD COLUMN revocation_reason TEXT;

    UPDATE refresh_tokens
    SET session_id = id,
        last_used_at = created_at,
        session_started_at = created_at;

    ALTER TABLE refresh_tokens
      ALTER COLUMN session_id SET NOT NULL,
      ALTER COLUMN last_used_at SET NOT NULL,
      ALTER COLUMN session_started_at SET NOT NULL;

    CREATE INDEX refresh_tokens_session_idx ON refresh_tokens(session_id);
    CREATE INDEX refresh_tokens_active_session_idx
      ON refresh_tokens(user_id, session_id, expires_at DESC)
      WHERE revoked_at IS NULL;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM coin_ledger
        WHERE entry_type = 'WELCOME_CREDIT'
        GROUP BY user_id
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'Cannot enforce one welcome credit per user: duplicate history exists';
      END IF;
    END $$;

    CREATE UNIQUE INDEX coin_ledger_one_welcome_per_user
      ON coin_ledger(user_id)
      WHERE entry_type = 'WELCOME_CREDIT';
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS coin_ledger_one_welcome_per_user;
    DROP INDEX IF EXISTS refresh_tokens_active_session_idx;
    DROP INDEX IF EXISTS refresh_tokens_session_idx;
    ALTER TABLE refresh_tokens
      DROP COLUMN IF EXISTS revocation_reason,
      DROP COLUMN IF EXISTS session_started_at,
      DROP COLUMN IF EXISTS last_used_at,
      DROP COLUMN IF EXISTS user_agent,
      DROP COLUMN IF EXISTS ip,
      DROP COLUMN IF EXISTS device_id,
      DROP COLUMN IF EXISTS session_id;
    DROP TABLE IF EXISTS email_verification_tokens;
    DROP TABLE IF EXISTS password_reset_tokens;
    DROP TABLE IF EXISTS auth_events;
    DROP TABLE IF EXISTS password_credentials;
    DROP TABLE IF EXISTS user_identities;
  `);
};
