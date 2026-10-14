// "Watch a video to double it" on the daily check-in. The app shows a rewarded ad (placement
// "checkin"); once AdMob's SSV callback has consumed the intent, POST /checkin/double spends it on a
// bonus equal to today's check-in reward.
//
// - CHECKIN_BONUS_CREDIT: the bonus itself. Backed — the impression's revenue is already recorded
//   by the SSV callback, which pays no coin of its own for the checkin placement.
// - rewarded_ad_intents.checkin_bonus_ledger_id: single-use proof, like spin_history_id and
//   chapter_unlock_id.
//
// ALTER TYPE ... ADD VALUE cannot share a transaction with later use of the value, so this runs
// outside one — same as 1700000000065.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.noTransaction();
  await pgm.db.query(`ALTER TYPE ledger_entry_type ADD VALUE IF NOT EXISTS 'CHECKIN_BONUS_CREDIT'`);
  await pgm.db.query(`
    ALTER TABLE rewarded_ad_intents
      ADD COLUMN IF NOT EXISTS checkin_bonus_ledger_id UUID REFERENCES coin_ledger(id)
  `);
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS rewarded_ad_intents_checkin_bonus_uniq
      ON rewarded_ad_intents(checkin_bonus_ledger_id)
      WHERE checkin_bonus_ledger_id IS NOT NULL
  `);
};

exports.down = async (pgm) => {
  pgm.noTransaction();
  // The enum value stays: Postgres has no DROP VALUE.
  await pgm.db.query(
    'ALTER TABLE rewarded_ad_intents DROP COLUMN IF EXISTS checkin_bonus_ledger_id',
  );
};
