// Mirrors 02-DATABASE-SCHEMA.md §7.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE spin_config (
      id           UUID PRIMARY KEY,
      name         TEXT NOT NULL,
      ticket_coin  BIGINT NOT NULL DEFAULT 100,
      daily_cap    SMALLINT NOT NULL DEFAULT 20,
      pity_threshold SMALLINT NOT NULL DEFAULT 15,   -- sau N lượt không trúng tier cao
      prizes       JSONB NOT NULL,
      -- [{"slot":1,"type":"coin","value":20,"weight":400,"tier":"low"},
      --  {"slot":6,"type":"coin","value":1000,"weight":19,"tier":"high"},
      --  {"slot":7,"type":"voucher","value":"discount_10pct","weight":50,"tier":"mid"},
      --  {"slot":8,"type":"coin","value":10000,"weight":1,"tier":"jackpot"}]
      is_active    BOOLEAN NOT NULL DEFAULT true,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE spin_history (
      id            UUID PRIMARY KEY,
      user_id       UUID NOT NULL REFERENCES users(id),
      spin_config_id UUID NOT NULL REFERENCES spin_config(id),
      server_seed_hash TEXT NOT NULL,            -- audit: hash(seed) công bố, seed lưu nội bộ
      roll          NUMERIC(10,8) NOT NULL,
      prize_slot    SMALLINT NOT NULL,
      prize_type    TEXT NOT NULL, prize_value TEXT NOT NULL,
      pity_applied  BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS spin_history;
    DROP TABLE IF EXISTS spin_config;
  `);
};
