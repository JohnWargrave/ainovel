// AI cover generation. One job per "Generate AI cover" click (or per imported novel without a
// cover): an LLM writes an art brief, Workers AI FLUX renders four candidates, and the admin picks
// one. The novel's cover only changes on that pick, so a job never touches novels.cover_*.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE novel_cover_jobs (
      id             UUID PRIMARY KEY,
      novel_id       UUID NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      status         TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','generating','ready','failed','applied','cancelled')),
      trigger        TEXT NOT NULL CHECK (trigger IN ('manual','import')),
      -- Set when the admin typed their own brief; the LLM step is skipped then.
      brief          JSONB,
      prompt         TEXT,
      model          TEXT,
      admin_user_id  UUID REFERENCES admin_users(id),
      errors         JSONB,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at    TIMESTAMPTZ
    );
    CREATE INDEX novel_cover_jobs_novel_idx ON novel_cover_jobs (novel_id, created_at DESC);
    -- One running job per novel: a second click while generating is a 409, not double the spend.
    CREATE UNIQUE INDEX novel_cover_jobs_running_uniq ON novel_cover_jobs (novel_id)
      WHERE status IN ('queued','generating');

    CREATE TABLE novel_cover_candidates (
      id          UUID PRIMARY KEY,
      job_id      UUID NOT NULL REFERENCES novel_cover_jobs(id) ON DELETE CASCADE,
      idx         SMALLINT NOT NULL,
      seed        BIGINT NOT NULL,
      -- covers/candidates/{job}/{idx}.webp with the title drawn on, and the same art without it.
      image_key   TEXT NOT NULL,
      clean_key   TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_at  TIMESTAMPTZ,
      UNIQUE (job_id, idx)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS novel_cover_candidates; DROP TABLE IF EXISTS novel_cover_jobs;');
};
