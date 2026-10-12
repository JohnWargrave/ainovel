// Global signup/login coin rewards managed by the CMS. Ledger indexes keep each reward one-time
// per account even when authentication requests race.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE coin_reward_settings (
      id             TEXT PRIMARY KEY CHECK (id = 'global'),
      welcome_coin   INTEGER NOT NULL DEFAULT 10000
        CHECK (welcome_coin BETWEEN 0 AND 10000000),
      google_login   INTEGER NOT NULL DEFAULT 2000
        CHECK (google_login BETWEEN 0 AND 10000000),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO coin_reward_settings (id, welcome_coin, google_login)
    VALUES ('global', 10000, 2000);

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM coin_ledger
        WHERE entry_type = 'LOGIN_BIND_CREDIT'
        GROUP BY user_id
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'Cannot enforce one Google login credit per user: duplicate history exists';
      END IF;
    END $$;

    CREATE UNIQUE INDEX coin_ledger_one_login_bind_per_user
      ON coin_ledger(user_id)
      WHERE entry_type = 'LOGIN_BIND_CREDIT';
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS coin_ledger_one_login_bind_per_user;
    DROP TABLE IF EXISTS coin_reward_settings;
  `);
};
