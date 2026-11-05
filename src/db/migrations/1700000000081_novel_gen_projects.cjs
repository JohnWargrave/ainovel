// AI novel generation from the CMS. One project per idea: an LLM drafts a story bible, then an
// outline, then writes the chapters one at a time as draft chapters of a regular novel. Every step
// is a background task (BullMQ "novel-gen"); the project row is both the editable plan and the
// state of whatever task is running on it.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE novel_gen_projects (
      id                UUID PRIMARY KEY,
      -- Created when writing starts. SET NULL so deleting the novel keeps the plan to retry from.
      novel_id          UUID REFERENCES novels(id) ON DELETE SET NULL,
      status            TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','running','idle','paused','failed')),
      -- The task running now, or the last one that ran.
      task              TEXT NOT NULL CHECK (task IN ('bible','outline','outline_chapter','chapters')),
      -- A new id per started task. The worker only writes while the row still carries its run id,
      -- so a stop or a newer task makes an in-flight call drop its result instead of racing it.
      run_id            UUID NOT NULL,
      -- What the admin asked for: idea, genres, language, tone, audience, sizes, auto_cover.
      input             JSONB NOT NULL,
      bible             JSONB,
      outline           JSONB,
      -- The admin's instruction for the queued regenerate, and the chapter it targets.
      task_note         TEXT,
      task_chapter_no   INTEGER,
      write_from        INTEGER,
      write_to          INTEGER,
      write_next        INTEGER,
      write_overwrite   BOOLEAN NOT NULL DEFAULT false,
      -- Live view for the CMS: a one-line progress note and the chapter text as it streams in.
      progress          TEXT,
      live_chapter_no   INTEGER,
      live_text         TEXT,
      model             TEXT,
      prompt_tokens     BIGINT NOT NULL DEFAULT 0,
      completion_tokens BIGINT NOT NULL DEFAULT 0,
      errors            JSONB NOT NULL DEFAULT '[]'::jsonb,
      admin_user_id     UUID REFERENCES admin_users(id),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX novel_gen_projects_created_idx ON novel_gen_projects (created_at DESC);
    CREATE INDEX novel_gen_projects_novel_idx ON novel_gen_projects (novel_id);

    -- Covers drafted for a generated novel: applied only while the novel still has no cover.
    ALTER TABLE novel_cover_jobs DROP CONSTRAINT novel_cover_jobs_trigger_check;
    ALTER TABLE novel_cover_jobs ADD CONSTRAINT novel_cover_jobs_trigger_check
      CHECK (trigger IN ('manual','import','generate'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS novel_gen_projects;
    DELETE FROM novel_cover_jobs WHERE trigger = 'generate';
    ALTER TABLE novel_cover_jobs DROP CONSTRAINT novel_cover_jobs_trigger_check;
    ALTER TABLE novel_cover_jobs ADD CONSTRAINT novel_cover_jobs_trigger_check
      CHECK (trigger IN ('manual','import'));
  `);
};
