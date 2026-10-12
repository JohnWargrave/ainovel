// Follow-up kept separate so databases that applied the first account-authentication migration
// during rollout converge without rewriting migration history.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS user_identities_one_provider_per_user
      ON user_identities(user_id, provider);

    ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS auth_provider TEXT;
    UPDATE refresh_tokens SET auth_provider = 'legacy' WHERE auth_provider IS NULL;
    ALTER TABLE refresh_tokens ALTER COLUMN auth_provider SET NOT NULL;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS auth_provider;
    DROP INDEX IF EXISTS user_identities_one_provider_per_user;
  `);
};
