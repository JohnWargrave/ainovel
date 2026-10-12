// Mirrors 02-DATABASE-SCHEMA.md §2.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE ledger_entry_type AS ENUM (
      'OFFERWALL_CREDIT','OFFERWALL_CLAWBACK',
      'REWARDED_AD_CREDIT','DRAMA_WATCH_CREDIT','CHECKIN_CREDIT','TASK_CREDIT','REFERRAL_CREDIT',
      'SPIN_TICKET_DEBIT','SPIN_PRIZE_CREDIT',
      'EPISODE_UNLOCK_DEBIT',   -- DEPRECATED: drama không còn unlock-gate, giữ cho tương thích
      'REDEMPTION_DEBIT','REDEMPTION_REFUND',
      'ADMIN_ADJUSTMENT','HOLD_RELEASE'
    );

    CREATE TABLE coin_ledger (
      id             UUID PRIMARY KEY,
      user_id        UUID NOT NULL REFERENCES users(id),
      entry_type     ledger_entry_type NOT NULL,
      amount         BIGINT NOT NULL,             -- dương = credit, âm = debit
      bucket         TEXT NOT NULL DEFAULT 'available',  -- 'pending' | 'available'
      ref_type       TEXT,                        -- 'earning_event'|'redemption'|'spin'|'episode_unlock'|...
      ref_id         UUID,                        -- FK mềm tới bảng nguồn
      balance_after  BIGINT NOT NULL,             -- available balance sau entry (snapshot)
      idempotency_key TEXT UNIQUE,                -- vd 'tapjoy:{tx_id}', 'ssv:{ad_unit}:{tx}'
      note           TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX coin_ledger_user_idx ON coin_ledger(user_id, created_at DESC);

    CREATE TABLE wallets (
      user_id          UUID PRIMARY KEY REFERENCES users(id),
      available_coin   BIGINT NOT NULL DEFAULT 0,
      pending_coin     BIGINT NOT NULL DEFAULT 0,
      lifetime_earned  BIGINT NOT NULL DEFAULT 0,
      lifetime_redeemed BIGINT NOT NULL DEFAULT 0,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (pending_coin >= 0)                   -- available có thể âm do clawback
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS wallets;
    DROP TABLE IF EXISTS coin_ledger;
    DROP TYPE IF EXISTS ledger_entry_type;
  `);
};
