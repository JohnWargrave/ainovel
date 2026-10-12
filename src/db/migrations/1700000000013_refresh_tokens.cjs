// New table, not in 02-DATABASE-SCHEMA.md — needed for refresh-token rotation/revocation (backend_doing.md
// Phase 1 §1.1). Only the SHA-256 hash of the token is stored, never the raw token.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE refresh_tokens (
      id           UUID PRIMARY KEY,
      user_id      UUID NOT NULL REFERENCES users(id),
      token_hash   TEXT NOT NULL UNIQUE,
      expires_at   TIMESTAMPTZ NOT NULL,
      revoked_at   TIMESTAMPTZ,
      replaced_by  UUID REFERENCES refresh_tokens(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS refresh_tokens;`);
};
