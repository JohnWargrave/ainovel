// Mirrors 02-DATABASE-SCHEMA.md §6. Table bodies are verbatim from the doc; only the
// declaration order is adjusted (drama_episodes before drama_ad_impressions) because the
// doc's own drama_ad_impressions has a forward FK to drama_episodes that Postgres can't
// resolve until that table exists — a documentation ordering issue, not a schema change.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE drama_series (
      id             UUID PRIMARY KEY,
      title          TEXT NOT NULL,
      description    TEXT, cover_url TEXT,
      license_regions CHAR(2)[] NOT NULL,        -- regions được phát theo hợp đồng
      license_expires DATE,                      -- hết hạn → auto ẩn + alert
      total_episodes SMALLINT NOT NULL,
      interstitial_every SMALLINT NOT NULL DEFAULT 2,  -- ad sau mỗi 2 tập
      status         TEXT NOT NULL DEFAULT 'draft',  -- draft|live|expired
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Mọi tập đều FREE — không còn unlock-gate (bảng episode_unlocks đã bỏ).
    -- Ledger enum EPISODE_UNLOCK_DEBIT: deprecated, giữ trong enum để tương thích, không dùng.
    -- DRAMA_WATCH_CREDIT: đổi ngữ nghĩa = credit 20% revenue interstitial (alias DRAMA_AD_CREDIT).

    CREATE TABLE drama_episodes (
      id            UUID PRIMARY KEY,
      series_id     UUID NOT NULL REFERENCES drama_series(id),
      episode_no    SMALLINT NOT NULL,
      byteplus_vid  TEXT NOT NULL,               -- media asset id trên BytePlus VOD
      duration_s    INT NOT NULL,
      UNIQUE (series_id, episode_no)
    );

    CREATE TABLE drama_ad_impressions (          -- audit + reconciliation cho interstitial share
      id             UUID PRIMARY KEY,
      user_id        UUID NOT NULL REFERENCES users(id),
      intent_id      UUID UNIQUE NOT NULL,       -- cấp tại /drama/interstitial/intent
      episode_id     UUID REFERENCES drama_episodes(id),
      ad_network     TEXT,                       -- admob|max
      revenue_source TEXT NOT NULL,              -- 'ilrd' | 'est_ecpm'
      est_revenue_usd NUMERIC(12,6) NOT NULL,
      coin_awarded   BIGINT NOT NULL,
      geo            CHAR(2),
      reconciled     BOOLEAN NOT NULL DEFAULT false,  -- job daily đối chiếu reporting API
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE watch_sessions (                -- phục vụ watch-to-earn verify
      id           UUID PRIMARY KEY,
      user_id      UUID NOT NULL, episode_id UUID NOT NULL,
      watch_time_s INT NOT NULL DEFAULT 0,
      geo          CHAR(2), ip INET,
      rewarded     BOOLEAN NOT NULL DEFAULT false,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS watch_sessions;
    DROP TABLE IF EXISTS drama_ad_impressions;
    DROP TABLE IF EXISTS drama_episodes;
    DROP TABLE IF EXISTS drama_series;
  `);
};
