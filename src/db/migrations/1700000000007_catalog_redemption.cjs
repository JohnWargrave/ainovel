// Mirrors 02-DATABASE-SCHEMA.md §4. catalog_items/catalog_staging created before redemptions
// (redemptions.catalog_item_id FK), matching doc order.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE redemption_status AS ENUM
      ('REQUESTED','FRAUD_REVIEW','APPROVED','PURCHASING','DELIVERED','REJECTED','FAILED');

    CREATE TABLE catalog_items (
      id            UUID PRIMARY KEY,
      sku           TEXT UNIQUE NOT NULL,        -- vd 'seagm-googleplay-us-10'
      title         TEXT NOT NULL,
      category      TEXT NOT NULL,               -- gift_card|game_card|paypal|telco|...
      face_value    TEXT NOT NULL,               -- '$10', '100 Diamonds'
      usd_cost      NUMERIC(12,4) NOT NULL,      -- giá vốn SeaGM hiện tại
      coin_price    BIGINT NOT NULL,             -- giá niêm yết (đã gồm buffer)
      image_url     TEXT,
      seagm_url     TEXT,                        -- deep link cho admin mua nhanh
      regions       CHAR(2)[] NOT NULL,          -- regions được đổi item này
      is_active     BOOLEAN NOT NULL DEFAULT false,
      stock_note    TEXT,
      source        TEXT NOT NULL DEFAULT 'crawler',  -- crawler|manual
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE catalog_staging (               -- crawler ghi vào đây, admin duyệt → merge
      id            UUID PRIMARY KEY,
      sku           TEXT NOT NULL,
      payload       JSONB NOT NULL,              -- item data crawler bắt được
      diff          JSONB,                       -- so với catalog_items hiện tại
      crawl_run_id  UUID NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|ignored
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE redemptions (
      id              UUID PRIMARY KEY,
      user_id         UUID NOT NULL REFERENCES users(id),
      catalog_item_id UUID NOT NULL REFERENCES catalog_items(id),
      coin_price      BIGINT NOT NULL,            -- snapshot giá lúc đặt
      usd_cost_est    NUMERIC(12,4) NOT NULL,     -- snapshot giá vốn SeaGM ước tính
      status          redemption_status NOT NULL DEFAULT 'REQUESTED',
      fraud_score_at_request SMALLINT,
      reviewed_by     UUID REFERENCES admin_users(id),
      reviewed_at     TIMESTAMPTZ,
      reject_reason   TEXT,
      delivery_code   TEXT,                       -- code gift card (encrypt at rest - pgcrypto)
      delivery_note   TEXT,
      delivered_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX redemptions_queue_idx ON redemptions(status, created_at);

    CREATE TABLE redemption_status_history (
      id            UUID PRIMARY KEY,
      redemption_id UUID NOT NULL REFERENCES redemptions(id),
      from_status   redemption_status, to_status redemption_status NOT NULL,
      actor         TEXT NOT NULL,               -- 'system' | admin_user_id
      note          TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS redemption_status_history;
    DROP TABLE IF EXISTS redemptions;
    DROP TABLE IF EXISTS catalog_staging;
    DROP TABLE IF EXISTS catalog_items;
    DROP TYPE IF EXISTS redemption_status;
  `);
};
