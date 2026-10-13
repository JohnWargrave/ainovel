// Novel read-to-earn: catalog, chapters, per-user reading state, VIP unlocks, and CMS import jobs.
//
// Content lives in Postgres (chapters are plain text, a few KB each); covers and raw import files
// live in S3-compatible storage and are referenced by key/URL only.
//
// Unlike drama, every chapter a user is rewarded for is a real row the server owns: word_count —
// which sets the minimum read time — is computed on write, never taken from the client.

exports.shorthands = undefined;

const NOVEL_DEFAULTS = {
  enabled: false,
  chapter_reward_coin: 10,
  reading_wpm: 300,
  min_read_ratio: 0.5,
  min_read_seconds: 30,
  max_read_seconds: 900,
  completion_scroll_ratio: 0.9,
  chapter_reward_daily_cap: 20,
};

// An ad that unlocks a chapter buys the chapter, not coin: multiplier 0 makes the SSV callback mint
// nothing for it (see computeCoin in ssv.service.ts).
const CHAPTER_UNLOCK_PLACEMENT = { daily_cap: 10, cooldown_s: 0, coin_multiplier: 0 };

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    CREATE TABLE novel_categories (
      id          UUID PRIMARY KEY,
      slug        TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      is_active   BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE novels (
      id                  UUID PRIMARY KEY,
      slug                TEXT NOT NULL UNIQUE,
      title               TEXT NOT NULL,
      alt_titles          TEXT[] NOT NULL DEFAULT '{}',
      author              TEXT,
      translator          TEXT,
      description         TEXT,
      cover_url           TEXT,
      cover_key           TEXT,
      status              TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','published','hidden','archived')),
      completion_status   TEXT NOT NULL DEFAULT 'ongoing'
                          CHECK (completion_status IN ('ongoing','completed','hiatus')),
      language            TEXT NOT NULL DEFAULT 'vi',
      tags                TEXT[] NOT NULL DEFAULT '{}',
      -- Country codes or region ids (same convention as catalog_items.regions). NULL = everywhere.
      regions             TEXT[],
      is_featured         BOOLEAN NOT NULL DEFAULT false,
      featured_rank       INTEGER NOT NULL DEFAULT 0,
      -- VIP policy: chapters numbered >= vip_from_chapter are VIP unless the chapter overrides.
      -- NULL = no automatic VIP (only chapters explicitly flagged is_vip are locked).
      vip_from_chapter    INTEGER CHECK (vip_from_chapter IS NULL OR vip_from_chapter >= 1),
      default_unlock_coin INTEGER NOT NULL DEFAULT 0 CHECK (default_unlock_coin >= 0),
      allow_ad_unlock     BOOLEAN NOT NULL DEFAULT true,
      chapter_count       INTEGER NOT NULL DEFAULT 0,
      word_count          BIGINT NOT NULL DEFAULT 0,
      -- Lower-cased title/alt titles/author, maintained by the app; trigram-indexed for search.
      search_text         TEXT NOT NULL DEFAULT '',
      published_at        TIMESTAMPTZ,
      created_by          UUID REFERENCES admin_users(id),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX novels_status_updated_idx ON novels(status, updated_at DESC);
    CREATE INDEX novels_featured_idx ON novels(featured_rank) WHERE is_featured;
    CREATE INDEX novels_search_trgm_idx ON novels USING GIN (search_text gin_trgm_ops);
    CREATE INDEX novels_tags_idx ON novels USING GIN (tags);

    CREATE TABLE novel_category_links (
      novel_id     UUID NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      category_id  UUID NOT NULL REFERENCES novel_categories(id) ON DELETE CASCADE,
      PRIMARY KEY (novel_id, category_id)
    );
    CREATE INDEX novel_category_links_category_idx ON novel_category_links(category_id);

    CREATE TABLE novel_chapters (
      id                UUID PRIMARY KEY,
      novel_id          UUID NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      chapter_no        INTEGER NOT NULL CHECK (chapter_no >= 1),
      title             TEXT NOT NULL DEFAULT '',
      content           TEXT NOT NULL DEFAULT '',
      word_count        INTEGER NOT NULL DEFAULT 0,
      -- NULL = follow the novel's vip_from_chapter policy; true/false = explicit override.
      is_vip            BOOLEAN,
      -- NULL = novels.default_unlock_coin.
      unlock_coin_price INTEGER CHECK (unlock_coin_price IS NULL OR unlock_coin_price >= 0),
      status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
      -- A published chapter with a future publish_at is scheduled: invisible until then.
      publish_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- DEFERRABLE so renumbering can shift a whole range in one statement.
      CONSTRAINT novel_chapters_novel_no_uniq UNIQUE (novel_id, chapter_no) DEFERRABLE INITIALLY IMMEDIATE
    );

    CREATE TABLE novel_chapter_revisions (
      id          UUID PRIMARY KEY,
      chapter_id  UUID NOT NULL REFERENCES novel_chapters(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      edited_by   UUID REFERENCES admin_users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX novel_chapter_revisions_chapter_idx ON novel_chapter_revisions(chapter_id, created_at DESC);

    CREATE TABLE novel_chapter_unlocks (
      id            UUID PRIMARY KEY,
      user_id       UUID NOT NULL REFERENCES users(id),
      chapter_id    UUID NOT NULL REFERENCES novel_chapters(id) ON DELETE CASCADE,
      novel_id      UUID NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      method        TEXT NOT NULL CHECK (method IN ('coin','ad')),
      coin_spent    INTEGER NOT NULL DEFAULT 0,
      ad_intent_id  UUID REFERENCES rewarded_ad_intents(id),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, chapter_id)
    );
    CREATE INDEX novel_chapter_unlocks_novel_idx ON novel_chapter_unlocks(novel_id, created_at DESC);

    CREATE TABLE novel_read_progress (
      id                 UUID PRIMARY KEY,
      user_id            UUID NOT NULL REFERENCES users(id),
      chapter_id         UUID NOT NULL REFERENCES novel_chapters(id) ON DELETE CASCADE,
      novel_id           UUID NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      -- Server-verified reading time; the reward decision is made on this, never on client claims.
      read_time_s        INTEGER NOT NULL DEFAULT 0,
      max_scroll_ratio   NUMERIC(4,3) NOT NULL DEFAULT 0,
      last_heartbeat_at  TIMESTAMPTZ NOT NULL,
      rewarded_at        TIMESTAMPTZ,
      completed_at       TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, chapter_id)
    );
    CREATE INDEX novel_read_progress_user_rewarded_idx
      ON novel_read_progress(user_id, rewarded_at DESC) WHERE rewarded_at IS NOT NULL;
    CREATE INDEX novel_read_progress_novel_idx ON novel_read_progress(novel_id, created_at DESC);

    CREATE TABLE novel_library (
      user_id          UUID NOT NULL REFERENCES users(id),
      novel_id         UUID NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
      last_chapter_id  UUID REFERENCES novel_chapters(id) ON DELETE SET NULL,
      last_chapter_no  INTEGER,
      last_read_at     TIMESTAMPTZ,
      in_bookshelf     BOOLEAN NOT NULL DEFAULT false,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, novel_id)
    );
    CREATE INDEX novel_library_user_recent_idx ON novel_library(user_id, last_read_at DESC);

    CREATE TABLE novel_import_jobs (
      id               UUID PRIMARY KEY,
      admin_user_id    UUID REFERENCES admin_users(id),
      format           TEXT NOT NULL CHECK (format IN ('epub','txt','md','docx','json','zip')),
      filename         TEXT NOT NULL,
      file_key         TEXT,
      mode             TEXT NOT NULL CHECK (mode IN ('new','append','replace')),
      target_novel_id  UUID REFERENCES novels(id) ON DELETE SET NULL,
      chapter_pattern  TEXT,
      status           TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','parsing','ready','committing','done','failed','cancelled')),
      preview          JSONB,
      stats            JSONB,
      errors           JSONB,
      result_novel_ids UUID[] NOT NULL DEFAULT '{}',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at      TIMESTAMPTZ
    );
    CREATE INDEX novel_import_jobs_created_idx ON novel_import_jobs(created_at DESC);

    -- Parsed-but-not-committed chapters, one set per job (a ZIP may carry several novels).
    CREATE TABLE novel_import_chapters (
      id           UUID PRIMARY KEY,
      job_id       UUID NOT NULL REFERENCES novel_import_jobs(id) ON DELETE CASCADE,
      novel_index  INTEGER NOT NULL DEFAULT 0,
      chapter_no   INTEGER NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      content      TEXT NOT NULL,
      word_count   INTEGER NOT NULL,
      warnings     TEXT[] NOT NULL DEFAULT '{}'
    );
    CREATE INDEX novel_import_chapters_job_idx ON novel_import_chapters(job_id, novel_index, chapter_no);

    ALTER TABLE rewarded_ad_intents
      ADD COLUMN chapter_unlock_id UUID REFERENCES novel_chapter_unlocks(id);
    CREATE UNIQUE INDEX rewarded_ad_intents_chapter_unlock_uniq
      ON rewarded_ad_intents(chapter_unlock_id)
      WHERE chapter_unlock_id IS NOT NULL;
  `);

  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(features, '{novel}', '${JSON.stringify(NOVEL_DEFAULTS)}'::jsonb, true),
        updated_at = now();

    UPDATE region_config
    SET features = jsonb_set(
          features,
          '{rewarded_ads,placements,chapter_unlock}',
          '${JSON.stringify(CHAPTER_UNLOCK_PLACEMENT)}'::jsonb,
          true
        ),
        updated_at = now()
    WHERE features #> '{rewarded_ads,placements}' IS NOT NULL;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = (features - 'novel') #- '{rewarded_ads,placements,chapter_unlock}',
        updated_at = now();

    DROP INDEX IF EXISTS rewarded_ad_intents_chapter_unlock_uniq;
    ALTER TABLE rewarded_ad_intents DROP COLUMN IF EXISTS chapter_unlock_id;

    DROP TABLE IF EXISTS novel_import_chapters;
    DROP TABLE IF EXISTS novel_import_jobs;
    DROP TABLE IF EXISTS novel_library;
    DROP TABLE IF EXISTS novel_read_progress;
    DROP TABLE IF EXISTS novel_chapter_unlocks;
    DROP TABLE IF EXISTS novel_chapter_revisions;
    DROP TABLE IF EXISTS novel_chapters;
    DROP TABLE IF EXISTS novel_category_links;
    DROP TABLE IF EXISTS novels;
    DROP TABLE IF EXISTS novel_categories;
  `);
};
