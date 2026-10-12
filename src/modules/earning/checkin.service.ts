import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { dayIndex, dayKey, dayWindow } from '../../lib/day-window.js';
import { creditInTransaction } from '../wallet-ledger/ledger.service.js';
import { loadUserRegionFeatures, readFeature } from './region-features.js';
import type { CheckinClaimResponse, CheckinStateResponse } from './checkin-schemas.js';

// Mirrors the seed in migration 14; only used if a region row somehow carries no rewards array.
const FALLBACK_REWARDS = [10, 15, 20, 25, 30, 40, 100];
// One year of history is more than enough to walk back a streak, and bounds the scan.
const STREAK_LOOKBACK = 365;

interface CheckinFeature {
  enabled: boolean;
  rewards: number[];
}

interface CheckinState {
  enabled: boolean;
  rewards: number[];
  streakDay: number;
  daysClaimed: number;
  todayClaimed: boolean;
  idempotencyKey: string;
  resetAt: Date;
}

// The reward table is 0-indexed by (day - 1) and repeats after the final configured day.
function rewardFor(rewards: number[], day: number): number {
  const index = (Math.max(day, 1) - 1) % rewards.length;
  return rewards[index] ?? 0;
}

function cycleDay(rewards: number[], consecutiveDay: number): number {
  return ((Math.max(consecutiveDay, 1) - 1) % rewards.length) + 1;
}

// Single source of truth for the streak, shared by GET /checkin/state and POST /checkin/claim —
// two independent implementations would inevitably disagree about what the user is owed.
async function computeCheckinState(userId: string, now = new Date()): Promise<CheckinState> {
  const { timezone, features } = await loadUserRegionFeatures(userId);
  const feature = readFeature<CheckinFeature>(features, 'checkin');
  const rewards =
    Array.isArray(feature.rewards) && feature.rewards.length > 0
      ? feature.rewards
      : FALLBACK_REWARDS;
  const window = dayWindow(timezone, now);

  const rows = await db
    .selectFrom('coin_ledger')
    .select(['created_at'])
    .where('user_id', '=', userId)
    .where('entry_type', '=', 'CHECKIN_CREDIT')
    .orderBy('created_at', 'desc')
    .limit(STREAK_LOOKBACK)
    .execute();

  const todayIndex = dayIndex(timezone, now);
  const claimedDays = rows.map((row) => dayIndex(timezone, new Date(row.created_at)));
  const todayClaimed = claimedDays[0] === todayIndex;

  // Walk back one region-local day at a time; the first gap ends the streak. When today has not
  // been claimed yet we start from yesterday, so an unbroken streak carries into today's claim.
  let streak = 0;
  let expected = todayClaimed ? todayIndex : todayIndex - 1;
  for (const claimed of claimedDays) {
    if (claimed > expected) continue; // same day counted twice — defensive, idempotency prevents it
    if (claimed !== expected) break;
    streak += 1;
    expected -= 1;
  }

  return {
    enabled: feature.enabled === true,
    rewards,
    // streakDay is always the day number the *current* claim lands on: today's if already claimed,
    // otherwise the day a claim right now would earn.
    streakDay: cycleDay(rewards, todayClaimed ? streak : streak + 1),
    // daysClaimed is the raw count of consecutive days already credited — no pre-emptive +1 and no
    // cycling. Clients that highlight "the day being claimed now" must read streakDay; deriving it
    // from a completed-day count is what made a brand-new account render day 2 before its first
    // claim, since streakDay alone reads the same (1) either side of that claim.
    daysClaimed: streak,
    todayClaimed,
    idempotencyKey: `checkin:${userId}:${dayKey(timezone, now)}`,
    resetAt: window.end,
  };
}

export async function getCheckinState(userId: string): Promise<CheckinStateResponse> {
  const state = await computeCheckinState(userId);
  // Unlike claim, state does not 404 on a disabled region: the app calls this to decide whether to
  // render the check-in card at all, and `enabled: false` is the answer it needs.
  const nextDay = state.todayClaimed ? state.streakDay + 1 : state.streakDay;
  return {
    enabled: state.enabled,
    streak_day: state.streakDay,
    days_claimed: state.daysClaimed,
    today_claimed: state.todayClaimed,
    rewards: state.rewards,
    next_reward_coin: rewardFor(state.rewards, nextDay),
    reset_at: state.resetAt.toISOString(),
  };
}

export async function claimCheckin(userId: string): Promise<CheckinClaimResponse> {
  const state = await computeCheckinState(userId);
  if (!state.enabled) {
    throw new AppError('FEATURE_DISABLED', 'Check-in is not available in your region', 404);
  }
  if (state.todayClaimed) {
    throw new AppError('ALREADY_CLAIMED', 'Check-in already claimed today', 409);
  }

  const coinAmount = rewardFor(state.rewards, state.streakDay);

  const result = await db.transaction().execute(async (trx) =>
    creditInTransaction(trx, {
      userId,
      entryType: 'CHECKIN_CREDIT',
      amount: coinAmount,
      bucket: 'available',
      idempotencyKey: state.idempotencyKey,
      note: `Daily check-in day ${String(state.streakDay)}`,
    }),
  );

  // The pre-check above catches the common case; this catches two concurrent claims, where both
  // reads saw an unclaimed day and the ledger's idempotency key decided the winner.
  if (result.deduped) {
    throw new AppError('ALREADY_CLAIMED', 'Check-in already claimed today', 409);
  }

  return {
    credited_coin: coinAmount,
    new_balance: result.balanceAfter,
    streak_day: state.streakDay,
  };
}
