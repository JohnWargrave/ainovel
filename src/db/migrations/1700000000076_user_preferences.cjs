// Genres a reader picked during onboarding (or later in settings), up to five. Drives the "For you"
// row on the novel home. category_ids is not an FK array (Postgres has none); the service validates
// ids on write and drops deactivated categories on read.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE user_preferences (
      user_id       UUID PRIMARY KEY REFERENCES users(id),
      category_ids  UUID[] NOT NULL DEFAULT '{}' CHECK (cardinality(category_ids) <= 5),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS user_preferences;');
};
