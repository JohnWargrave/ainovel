// 01-COIN-ECONOMY.md §2.4 names WELCOME_CREDIT/LOGIN_BIND_CREDIT explicitly, but they were missing from the
// ledger_entry_type enum created in 1700000000005_ledger_wallets.cjs (already applied — never edit that file).
// ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds it, so this migration runs outside
// a transaction.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.noTransaction();
  await pgm.db.query(`ALTER TYPE ledger_entry_type ADD VALUE IF NOT EXISTS 'WELCOME_CREDIT'`);
  await pgm.db.query(`ALTER TYPE ledger_entry_type ADD VALUE IF NOT EXISTS 'LOGIN_BIND_CREDIT'`);
};

exports.down = () => {
  // Postgres has no DROP VALUE for enums; down is a deliberate no-op (documented limitation).
};
