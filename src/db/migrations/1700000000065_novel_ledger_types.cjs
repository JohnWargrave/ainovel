// The app pivots from drama watch-to-earn to novel read-to-earn. Two new ledger entry types:
//
// - NOVEL_READ_CREDIT: coin for finishing a free chapter. Unbacked (no revenue behind it), so it
//   joins the rolling unbacked cap in ledger.service.ts.
// - CHAPTER_UNLOCK_DEBIT: coin spent to unlock a VIP chapter.
//
// DRAMA_WATCH_CREDIT / EPISODE_UNLOCK_DEBIT stay in the enum: Postgres cannot drop enum values, and
// historical ledger rows still carry them.
//
// ALTER TYPE ... ADD VALUE cannot run in the transaction that later uses the value, so this
// migration runs outside one — same reasoning as 1700000000011.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.noTransaction();
  await pgm.db.query(`ALTER TYPE ledger_entry_type ADD VALUE IF NOT EXISTS 'NOVEL_READ_CREDIT'`);
  await pgm.db.query(`ALTER TYPE ledger_entry_type ADD VALUE IF NOT EXISTS 'CHAPTER_UNLOCK_DEBIT'`);
};

exports.down = () => {
  // Postgres has no DROP VALUE for enums; down is a deliberate no-op (documented limitation).
};
