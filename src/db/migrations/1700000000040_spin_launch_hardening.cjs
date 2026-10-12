// Lucky Spin launch hardening:
// - distinguish free-spin minting so the shared ledger can enforce the unbacked rolling cap;
// - retain the server seed used to derive the roll, making a recorded result auditable;
// - keep the MVP prize tables coin-only until voucher/boost entitlement storage exists.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.noTransaction();
  await pgm.db.query(
    `ALTER TYPE ledger_entry_type ADD VALUE IF NOT EXISTS 'FREE_SPIN_PRIZE_CREDIT'`,
  );
  await pgm.db.query(`ALTER TABLE spin_history ADD COLUMN server_seed TEXT`);
  await pgm.db.query(`
    UPDATE spin_config
    SET prizes = (
      SELECT jsonb_agg(
        CASE
          WHEN prize->>'type' IN ('voucher', 'boost') THEN
            prize || jsonb_build_object(
              'type', 'coin',
              'value', CASE WHEN ticket_coin = 0 THEN 30 ELSE 50 END,
              'label', CASE WHEN ticket_coin = 0 THEN '30 coin' ELSE '50 coin' END
            )
          ELSE prize
        END
        ORDER BY (prize->>'slot')::int
      )
      FROM jsonb_array_elements(prizes) AS prize
    ), updated_at = now()
    WHERE is_active = true
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(prizes) AS prize
        WHERE prize->>'type' IN ('voucher', 'boost')
      )
  `);
};

exports.down = async (pgm) => {
  // PostgreSQL cannot remove an enum value. Prize-table replacement is also intentionally retained:
  // reverting it could issue prizes for which no entitlement exists.
  await pgm.db.query(`ALTER TABLE spin_history DROP COLUMN IF EXISTS server_seed`);
};
