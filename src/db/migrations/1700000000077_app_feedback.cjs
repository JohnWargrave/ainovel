// What a reader sends from the "Rate the app" screen: a 1–5 star rating and, optionally, a message
// and a reply-to address. Read in the CMS; nothing acts on it automatically.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE app_feedback (
      id           UUID PRIMARY KEY,
      user_id      UUID NOT NULL REFERENCES users(id),
      rating       SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
      message      TEXT CHECK (char_length(message) <= 2000),
      email        TEXT,
      app_version  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX app_feedback_user_idx ON app_feedback (user_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS app_feedback;');
};
