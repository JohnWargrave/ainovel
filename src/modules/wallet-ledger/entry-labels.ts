// Human-readable labels for ledger_entry_type, served alongside the raw enum so the app doesn't
// have to keep its own copy of this map — adding an entry type used to silently degrade every
// existing client's history screen to a generic "Coin activity" row.
//
// Keep in sync with the ledger_entry_type enum (migrations 5, 11, 23).
const ENTRY_LABELS: Record<string, string> = {
  OFFERWALL_CREDIT: 'Offer reward',
  OFFERWALL_CLAWBACK: 'Offer reversed',
  REWARDED_AD_CREDIT: 'Ad reward',
  DRAMA_WATCH_CREDIT: 'Episode reward',
  CHECKIN_CREDIT: 'Daily check-in',
  TASK_CREDIT: 'Task reward',
  REFERRAL_CREDIT: 'Referral bonus',
  REFERRAL_CLAWBACK: 'Referral reversed',
  SPIN_TICKET_DEBIT: 'Spin ticket',
  SPIN_PRIZE_CREDIT: 'Spin prize',
  FREE_SPIN_PRIZE_CREDIT: 'Daily free spin prize',
  EPISODE_UNLOCK_DEBIT: 'Episode unlock',
  REDEMPTION_DEBIT: 'Redemption',
  REDEMPTION_REFUND: 'Redemption refunded',
  ADMIN_ADJUSTMENT: 'Adjustment',
  HOLD_RELEASE: 'Pending released',
  WELCOME_CREDIT: 'Welcome bonus',
  LOGIN_BIND_CREDIT: 'Account linked bonus',
};

export function entryLabel(entryType: string): string {
  return ENTRY_LABELS[entryType] ?? 'Coin activity';
}
