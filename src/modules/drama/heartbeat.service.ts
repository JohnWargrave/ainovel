import { uuidv7 } from 'uuidv7';
import type { Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { dayWindow } from '../../lib/day-window.js';
import { creditInTransaction } from '../wallet-ledger/ledger.service.js';
import { recordMint } from '../wallet-ledger/economy-counters.js';
import { loadUserRegionFeatures } from '../earning/region-features.js';
import { parseDramaFeature, type DramaFeature } from './region-feature.js';
import type { WatchHeartbeatBody, WatchHeartbeatResponse } from './schemas.js';

// Bounds a single heartbeat's contribution. A player that is backgrounded, suspended, or simply
// loses the network for an hour comes back with a large gap in both the client position and the
// wall clock; without this, that gap banks as watch time in one call. 120s comfortably covers a
// normal beat interval plus retry jitter.
const MAX_GAIN_PER_BEAT_S = 120;

// Matches the schema bounds on duration_seconds. Applied again here because duration_s is persisted
// and then trusted for the rest of the episode.
const MIN_DURATION_S = 10;
const MAX_DURATION_S = 7200;

interface ProgressRow {
  id: string;
  duration_s: number;
  watch_time_s: number;
  last_position_s: number;
  last_heartbeat_at: Date;
  rewarded_at: Date | null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * The entire anti-cheat, in one expression.
 *
 * `clientDelta` is how far the player claims to have advanced; `serverDelta` is how much real time
 * actually passed between the two heartbeats. Credit the smaller of the two:
 *
 *  - Seeking forward makes clientDelta huge while serverDelta stays at one beat, so a scrub to 80%
 *    accrues one beat's worth of time. Seeking is not an error and needs no special case — it just
 *    cannot buy progress.
 *  - Replaying heartbeats slowly to fake a long watch makes serverDelta huge while clientDelta stays
 *    small, so a paused player accrues nothing no matter how long it waits.
 *  - Rewinding makes clientDelta negative, and the lower clamp floors it at zero.
 *
 * The net effect is that finishing an episode costs real, foreground, forward-moving time.
 */
function verifiedGain(clientDeltaS: number, serverDeltaS: number): number {
  return clamp(Math.min(clientDeltaS, serverDeltaS), 0, MAX_GAIN_PER_BEAT_S);
}

/**
 * Read rather than derived, and read on every beat rather than only on the one that credits.
 *
 * `new_balance` used to be null on every response except the single beat that paid, which made a
 * working reward indistinguishable from a disabled one from the client's side: the app polls this
 * endpoint every few seconds, so the one beat carrying a balance is trivially missed and every
 * other beat says null. `rewarded` is still the one-shot signal the reward animation fires on —
 * this field is now just "what the wallet holds right now", which is what a player HUD actually
 * wants and what makes a null genuinely mean "something is wrong".
 */
async function currentBalance(trx: Transaction<DB>, userId: string): Promise<string> {
  const wallet = await trx
    .selectFrom('wallets')
    .select('available_coin')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return (wallet?.available_coin ?? 0).toString();
}

async function countRewardedToday(
  trx: Transaction<DB>,
  userId: string,
  timezone: string,
  now: Date,
): Promise<number> {
  const window = dayWindow(timezone, now);
  const row = await trx
    .selectFrom('drama_watch_progress')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .where('user_id', '=', userId)
    .where('rewarded_at', '>=', window.start)
    .where('rewarded_at', '<', window.end)
    .executeTakeFirstOrThrow();
  return Number(row.total);
}

export async function recordWatchHeartbeat(
  userId: string,
  body: WatchHeartbeatBody,
  now = new Date(),
): Promise<WatchHeartbeatResponse> {
  // Also enforces account standing — a banned or suspended account gets 403 here rather than
  // silently accruing progress it can never be paid for.
  const { timezone, features } = await loadUserRegionFeatures(userId);
  const feature = parseDramaFeature(features);

  const result = await db.transaction().execute(async (trx) => {
    // Insert-then-lock rather than lock-then-insert. SELECT FOR UPDATE cannot lock a row that does
    // not exist yet, so two first heartbeats arriving together would both fall through to an INSERT
    // and one would die on the unique constraint. ON CONFLICT DO NOTHING makes the loser a no-op;
    // its subsequent FOR UPDATE then blocks on the winner and reads the committed row.
    const created = await insertBaseline(trx, userId, body, now);

    const row = await trx
      .selectFrom('drama_watch_progress')
      .select([
        'id',
        'duration_s',
        'watch_time_s',
        'last_position_s',
        'last_heartbeat_at',
        'rewarded_at',
      ])
      .where('user_id', '=', userId)
      .where('drama_id', '=', body.drama_id)
      .where('episode_index', '=', body.episode_index)
      .forUpdate()
      .executeTakeFirstOrThrow();

    // The first heartbeat only establishes a baseline and accrues nothing. An app that opens
    // claiming elapsed_seconds 9999 therefore starts from zero watch time, not from "already
    // finished".
    const progress = created ? row : await advance(trx, row, body, now);

    return applyReward(trx, userId, body, progress, feature, timezone, now);
  });

  // Best-effort and post-commit, and only for a credit that actually happened — same handling as
  // every other mint path.
  if (result.regionId && result.mintedCoin > 0) {
    void recordMint(result.regionId, result.mintedCoin).catch(() => undefined);
  }

  return result.response;
}

/** Returns true when this call created the row — i.e. this is the episode's first heartbeat. */
async function insertBaseline(
  trx: Transaction<DB>,
  userId: string,
  body: WatchHeartbeatBody,
  now: Date,
): Promise<boolean> {
  const durationS = clamp(body.duration_seconds, MIN_DURATION_S, MAX_DURATION_S);
  const result = await trx
    .insertInto('drama_watch_progress')
    .values({
      id: uuidv7(),
      user_id: userId,
      drama_id: body.drama_id,
      episode_index: body.episode_index,
      duration_s: durationS,
      watch_time_s: 0,
      last_position_s: clamp(body.elapsed_seconds, 0, durationS),
      last_heartbeat_at: now,
    })
    .onConflict((oc) => oc.columns(['user_id', 'drama_id', 'episode_index']).doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}

async function advance(
  trx: Transaction<DB>,
  row: ProgressRow,
  body: WatchHeartbeatBody,
  now: Date,
): Promise<ProgressRow> {
  const clientDeltaS = body.elapsed_seconds - row.last_position_s;
  // Rounded rather than floored: flooring loses up to a second on every beat, which compounds into
  // a completion threshold an honest viewer can never reach.
  const serverDeltaS = Math.round((now.getTime() - row.last_heartbeat_at.getTime()) / 1000);

  const watchTimeS = Math.min(
    row.watch_time_s + verifiedGain(clientDeltaS, serverDeltaS),
    // duration_s is never updated from the body: a later beat claiming a shorter duration must not
    // be able to make the completion threshold cheaper.
    row.duration_s,
  );
  const lastPositionS = clamp(body.elapsed_seconds, 0, row.duration_s);

  await trx
    .updateTable('drama_watch_progress')
    .set({ watch_time_s: watchTimeS, last_position_s: lastPositionS, last_heartbeat_at: now })
    .where('id', '=', row.id)
    .execute();

  return { ...row, watch_time_s: watchTimeS, last_position_s: lastPositionS };
}

interface RewardOutcome {
  response: WatchHeartbeatResponse;
  regionId: string | null;
  mintedCoin: number;
}

async function applyReward(
  trx: Transaction<DB>,
  userId: string,
  body: WatchHeartbeatBody,
  row: ProgressRow,
  feature: DramaFeature,
  timezone: string,
  now: Date,
): Promise<RewardOutcome> {
  const requiredS = Math.ceil(row.duration_s * feature.completion_ratio);
  const base = {
    watched_seconds: row.watch_time_s,
    required_seconds: requiredS,
    duration_seconds: row.duration_s,
  };

  const alreadyRewarded = row.rewarded_at !== null;
  const rewardedToday = await countRewardedToday(trx, userId, timezone, now);
  const remainingToday = Math.max(feature.episode_reward_daily_cap - rewardedToday, 0);
  // Read before the credit, so the dedupe path below reports the balance that credit already
  // produced rather than a stale zero.
  const balance = await currentBalance(trx, userId);

  const unpaid: RewardOutcome = {
    response: {
      ...base,
      rewarded: false,
      credited_coin: 0,
      new_balance: balance,
      daily_remaining: remainingToday,
    },
    regionId: null,
    mintedCoin: 0,
  };

  // Every one of these is a normal, expected state rather than a client error. This endpoint fires
  // every few seconds underneath a playing video, so throwing here would surface as a broken player
  // over a condition the viewer did nothing wrong to reach. The app reads `rewarded`, not the status
  // code. The only non-200 paths are auth, account standing, the rate limit, and the ledger's own
  // caps.
  if (
    !feature.enabled ||
    feature.episode_reward_coin <= 0 ||
    alreadyRewarded ||
    row.watch_time_s < requiredS ||
    remainingToday <= 0
  ) {
    return unpaid;
  }

  const ledger = await creditInTransaction(trx, {
    userId,
    entryType: 'DRAMA_WATCH_CREDIT',
    amount: feature.episode_reward_coin,
    // Keyed on the episode rather than on this row's id, so even a duplicate progress row could not
    // produce a second credit. That is precisely the defect watch_sessions carried.
    idempotencyKey: `drama-episode:${userId}:${body.drama_id}:${String(body.episode_index)}`,
    note: 'Drama episode reward',
  });

  await trx
    .updateTable('drama_watch_progress')
    .set({ rewarded_at: now })
    .where('id', '=', row.id)
    .execute();

  if (ledger.deduped) return unpaid;

  return {
    response: {
      ...base,
      rewarded: true,
      credited_coin: feature.episode_reward_coin,
      new_balance: ledger.balanceAfter,
      daily_remaining: Math.max(remainingToday - 1, 0),
    },
    regionId: ledger.regionId,
    mintedCoin: ledger.mintedAmount,
  };
}
