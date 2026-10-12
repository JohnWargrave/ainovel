// Mirrors 02-DATABASE-SCHEMA.md §1.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE users (
      id              UUID PRIMARY KEY,
      auth_provider   TEXT NOT NULL,              -- 'google' | 'anonymous_upgraded'
      auth_subject    TEXT NOT NULL,              -- provider user id
      email           TEXT,
      country_code    CHAR(2) NOT NULL,           -- resolved at signup, IP-based
      region_id       TEXT NOT NULL REFERENCES region_config(region_id),
      trust_level     SMALLINT NOT NULL DEFAULT 0,        -- 0..3
      status          TEXT NOT NULL DEFAULT 'active',     -- active|suspended|banned
      fraud_score     SMALLINT NOT NULL DEFAULT 0,        -- 0..100, cached từ fraud engine
      referral_code   TEXT UNIQUE,
      referred_by     UUID REFERENCES users(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (auth_provider, auth_subject)
    );

    CREATE TABLE devices (
      id                UUID PRIMARY KEY,
      user_id           UUID NOT NULL REFERENCES users(id),
      fingerprint_hash  TEXT NOT NULL,            -- server-computed từ device signals
      gaid              TEXT,                     -- Google Advertising ID (cần cho offerwall attribution)
      model             TEXT, os_version TEXT, app_version TEXT,
      play_integrity_verdict JSONB,               -- verdict gần nhất
      is_emulator       BOOLEAN NOT NULL DEFAULT false,
      is_rooted         BOOLEAN NOT NULL DEFAULT false,
      first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX devices_fingerprint_active ON devices(fingerprint_hash);
    -- Rule: 1 fingerprint chỉ gắn 1 user active. Đăng ký trên device đã có user khác → chặn (05-FRAUD).
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS devices;
    DROP TABLE IF EXISTS users;
  `);
};
