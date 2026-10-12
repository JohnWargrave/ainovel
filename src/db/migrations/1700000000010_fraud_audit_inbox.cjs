// Mirrors 02-DATABASE-SCHEMA.md §8 (fraud_flags, audit_log) and §9 (inbox_messages).
// admin_users itself was created earlier (1700000000003) so users/redemptions could FK to it.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE fraud_flags (
      id         UUID PRIMARY KEY,
      user_id    UUID NOT NULL REFERENCES users(id),
      rule_code  TEXT NOT NULL,                  -- xem 05-FRAUD-ENGINE
      severity   SMALLINT NOT NULL,              -- 1..5
      evidence   JSONB,
      status     TEXT NOT NULL DEFAULT 'open',   -- open|dismissed|confirmed
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE audit_log (
      id UUID PRIMARY KEY,
      admin_user_id UUID REFERENCES admin_users(id),
      action TEXT NOT NULL, target_type TEXT, target_id UUID,
      detail JSONB, ip INET,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE inbox_messages (
      id         UUID PRIMARY KEY,
      user_id    UUID NOT NULL REFERENCES users(id),
      type       TEXT NOT NULL,        -- 'redemption_delivered'|'announcement'|'reward'
      title      TEXT NOT NULL, body TEXT NOT NULL,
      payload    JSONB,                -- {redemption_id, code_masked...} code thật lấy qua API riêng có auth
      read_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS inbox_messages;
    DROP TABLE IF EXISTS audit_log;
    DROP TABLE IF EXISTS fraud_flags;
  `);
};
