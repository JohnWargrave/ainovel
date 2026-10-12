// Mirrors 02-DATABASE-SCHEMA.md §3.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE earning_events (
      id              UUID PRIMARY KEY,
      user_id         UUID NOT NULL REFERENCES users(id),
      device_id       UUID REFERENCES devices(id),
      source          TEXT NOT NULL,        -- 'tapjoy'|'adjoe'|'adgate'|'appsprize'|'pubscale'|'admob_ssv'|'drama'|'checkin'|'task'
      network_tx_id   TEXT,                 -- transaction id từ network
      payout_usd      NUMERIC(12,4),        -- payout thô network trả
      coin_awarded    BIGINT NOT NULL,
      share_applied   NUMERIC(5,4),         -- vd 0.3500
      geo_at_event    CHAR(2),
      ip_at_event     INET,
      status          TEXT NOT NULL DEFAULT 'credited',  -- credited|clawed_back
      raw_payload     JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (source, network_tx_id)
    );

    CREATE TABLE postback_logs (              -- log MỌI request tới gateway, kể cả bị reject
      id           UUID PRIMARY KEY,
      network      TEXT NOT NULL,
      remote_ip    INET NOT NULL,
      query_params JSONB NOT NULL,
      verdict      TEXT NOT NULL,             -- accepted|duplicate|bad_signature|bad_ip|user_not_found|error
      earning_event_id UUID REFERENCES earning_events(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS postback_logs;
    DROP TABLE IF EXISTS earning_events;
  `);
};
