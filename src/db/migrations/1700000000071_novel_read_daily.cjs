// Per-user, per-region-local-day reading totals, written by POST /novels/read-heartbeat in the same
// transaction as novel_read_progress. novel_read_progress is cumulative per chapter, so it cannot
// answer "how long did this user read today" — which the progress tasks ("Read for 10 minutes",
// "Finish 3 chapters") need.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE novel_read_daily (
      user_id             UUID NOT NULL REFERENCES users(id),
      day                 DATE NOT NULL,
      read_seconds        INTEGER NOT NULL DEFAULT 0 CHECK (read_seconds >= 0),
      chapters_completed  INTEGER NOT NULL DEFAULT 0 CHECK (chapters_completed >= 0),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, day)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS novel_read_daily;');
};
