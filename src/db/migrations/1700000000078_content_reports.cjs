// Reports readers file against a novel, a chapter or the app itself ("Report a problem"). Staff work
// them in the CMS: open -> resolved | dismissed, recording who closed each one.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE content_reports (
      id           UUID PRIMARY KEY,
      user_id      UUID NOT NULL REFERENCES users(id),
      target_type  TEXT NOT NULL CHECK (target_type IN ('novel', 'chapter', 'app')),
      -- The novel or chapter id; null for app reports. Not an FK: one column, two tables.
      target_id    UUID,
      reason       TEXT NOT NULL
                     CHECK (reason IN ('inappropriate', 'copyright', 'wrong_content', 'spam', 'other')),
      message      TEXT CHECK (char_length(message) <= 2000),
      status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
      resolved_by  UUID REFERENCES admin_users(id),
      resolved_at  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((target_type = 'app') = (target_id IS NULL))
    );
    CREATE INDEX content_reports_status_idx ON content_reports (status, id DESC);
    CREATE INDEX content_reports_target_idx ON content_reports (target_id) WHERE target_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS content_reports;');
};
