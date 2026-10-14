// Fields the Novelico v3 story cards and detail page show:
// - rating: editor-entered 0.0–5.0 score; null hides the stars.
// - read_count: distinct readers who have opened a chapter; bumped when a reader's novel_library row
//   is first created, so it never double-counts a returning reader.
// - ai_generated / editor_reviewed: the "AI-generated · editor reviewed" disclosure.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE novels
      ADD COLUMN rating NUMERIC(2,1) CHECK (rating BETWEEN 0 AND 5),
      ADD COLUMN read_count BIGINT NOT NULL DEFAULT 0 CHECK (read_count >= 0),
      ADD COLUMN ai_generated BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN editor_reviewed BOOLEAN NOT NULL DEFAULT false;

    -- Backfill from the readers each novel already has.
    UPDATE novels n
    SET read_count = c.readers
    FROM (SELECT novel_id, count(*) AS readers FROM novel_library GROUP BY novel_id) c
    WHERE c.novel_id = n.id;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE novels
      DROP COLUMN IF EXISTS rating,
      DROP COLUMN IF EXISTS read_count,
      DROP COLUMN IF EXISTS ai_generated,
      DROP COLUMN IF EXISTS editor_reviewed;
  `);
};
