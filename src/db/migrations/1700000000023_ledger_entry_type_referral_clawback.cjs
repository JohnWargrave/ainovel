// REFERRAL_CLAWBACK wasn't anticipated when ledger_entry_type was created (1700000000005, already
// applied — never edit that file). ALTER TYPE ... ADD VALUE cannot run inside the same transaction
// that adds it, so this migration runs outside a transaction — same pattern as 1700000000011.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.noTransaction();
  await pgm.db.query(`ALTER TYPE ledger_entry_type ADD VALUE IF NOT EXISTS 'REFERRAL_CLAWBACK'`);
};

exports.down = () => {
  // Postgres has no DROP VALUE for enums; down is a deliberate no-op (documented limitation).
};
