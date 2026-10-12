// 01-COIN-ECONOMY.md D1: fixed anchor, never changes.
export const COIN_PER_USD = 10_000;

// The cheapest supported payout. Redemption caps below this value cannot permit any catalog item.
export const MIN_REDEMPTION_USD = 5;

// 11-REFERRAL.md §1: referee_share + referrer_share must never exceed this fraction of payout_usd —
// the house keeps at least 40% margin regardless of trust-level share or referral config changes.
export const MAX_TOTAL_SHARE = 0.6;
