// Time-boxed reward multipliers, e.g. the "×2 boost for 1 hour" lucky-spin prize. A boost won while
// another is running is queued behind it (starts_at = the running one's expires_at), so the active
// multiplier at any instant is the row whose [starts_at, expires_at) window contains it.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE user_boosts (
      id          UUID PRIMARY KEY,
      user_id     UUID NOT NULL REFERENCES users(id),
      multiplier  INTEGER NOT NULL CHECK (multiplier BETWEEN 2 AND 10),
      starts_at   TIMESTAMPTZ NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL CHECK (expires_at > starts_at),
      source      TEXT NOT NULL,
      source_id   UUID,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX user_boosts_user_expires_idx ON user_boosts(user_id, expires_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS user_boosts;');
};
