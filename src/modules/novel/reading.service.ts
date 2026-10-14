import { uuidv7 } from 'uuidv7';
import type { Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { dayKey, dayWindow } from '../../lib/day-window.js';
import { lockRedis } from '../../redis/index.js';
import { creditInTransaction } from '../wallet-ledger/ledger.service.js';
import { recordMint } from '../wallet-ledger/economy-counters.js';
import { loadUserRegionFeatures } from '../earning/region-features.js';
import { activeBoost } from '../spin/boost.service.js';
import {
  chapterLockedError,
  findReadableChapter,
  hasUnlocked,
  isChapterVip,
  loadReader,
} from './access.js';
import { parseNovelFeature, requiredReadSeconds } from './region-feature.js';
import type { ReadHeartbeatBody, ReadHeartbeatResponse } from './schemas.js';

// Bounds one heartbeat's contribution. The app beats every ~10s; a reader that backgrounds the app
// or loses the network comes back with a large wall-clock gap that must not bank as reading time.
const MAX_GAIN_PER_BEAT_S = 30;

// How long a chapter stays "the one being read" without a beat. Only the active chapter accrues
// time, so beating several chapters in parallel earns nothing for any of them.
const ACTIVE_CHAPTER_TTL_S = 60;

// SET with GET in one round trip: returns the previous active chapter and claims the slot.
const SWAP_ACTIVE_CHAPTER = `
local previous = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return previous
`;

async function swapActiveChapter(userId: string, chapterId: string): Promise<string | null> {
  const previous = await lockRedis.eval(
    SWAP_ACTIVE_CHAPTER,
    1,
    `novel:active-chapter:${userId}`,
    chapterId,
    ACTIVE_CHAPTER_TTL_S,
  );
  return typeof previous === 'string' ? previous : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

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
    .selectFrom('novel_read_progress')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .where('user_id', '=', userId)
    .where('rewarded_at', '>=', window.start)
    .where('rewarded_at', '<', window.end)
    .executeTakeFirstOrThrow();
  return Number(row.total);
}

/**
 * Anti-cheat, in short: the server owns the chapter (and so its word count and the minimum read time
 * derived from it); reading time is the server clock between consecutive beats on the *active*
 * chapter, capped per beat; the first beat on a chapter only sets a baseline; and the per-user row
 * lock serializes the daily cap across chapters.
 */
export async function recordReadHeartbeat(
  userId: string,
  body: ReadHeartbeatBody,
  now = new Date(),
): Promise<ReadHeartbeatResponse> {
  // Also enforces account standing: a banned or suspended account gets 403 here rather than
  // accruing progress it can never be paid for.
  const { timezone, features } = await loadUserRegionFeatures(userId);
  const feature = parseNovelFeature(features);
  const reader = await loadReader(userId);
  const chapter = await findReadableChapter(reader, { chapterId: body.chapter_id }, now);
  const vip = isChapterVip(chapter, chapter);
  if (vip && !(await hasUnlocked(userId, chapter.id))) {
    throw chapterLockedError(chapter);
  }
  const requiredS = requiredReadSeconds(chapter.word_count, feature);
  const continuing = (await swapActiveChapter(userId, chapter.id)) === chapter.id;

  const result = await db.transaction().execute(async (trx) => {
    // Serializes every reward decision for this user, so beats on different chapters cannot both
    // see the last slot of the daily cap. Lock order (users → progress → wallets) matches the
    // redemption path.
    await trx
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const inserted = await trx
      .insertInto('novel_read_progress')
      .values({
        id: uuidv7(),
        user_id: userId,
        chapter_id: chapter.id,
        novel_id: chapter.novel_id,
        max_scroll_ratio: body.scroll_ratio.toFixed(3),
        last_heartbeat_at: now,
      })
      .onConflict((oc) => oc.columns(['user_id', 'chapter_id']).doNothing())
      .executeTakeFirst();
    const created = Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0;

    const row = await trx
      .selectFrom('novel_read_progress')
      .select([
        'id',
        'read_time_s',
        'max_scroll_ratio',
        'last_heartbeat_at',
        'rewarded_at',
        'completed_at',
      ])
      .where('user_id', '=', userId)
      .where('chapter_id', '=', chapter.id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    let readTimeS = row.read_time_s;
    if (!created && continuing) {
      // Rounded rather than floored: flooring loses up to a second per beat, which compounds into a
      // threshold an honest reader can never reach.
      const serverDeltaS = Math.round(
        (now.getTime() - new Date(row.last_heartbeat_at).getTime()) / 1000,
      );
      readTimeS += clamp(serverDeltaS, 0, MAX_GAIN_PER_BEAT_S);
    }
    const scrollRatio = Math.max(Number(row.max_scroll_ratio), body.scroll_ratio);
    const complete = readTimeS >= requiredS && scrollRatio >= feature.completion_scroll_ratio;
    const gainedS = readTimeS - row.read_time_s;
    const newlyCompleted = complete && row.completed_at === null;
    if (gainedS > 0 || newlyCompleted) {
      // Daily totals for the progress tasks, keyed on the region-local day like every daily reset.
      await trx
        .insertInto('novel_read_daily')
        .values({
          user_id: userId,
          day: dayKey(timezone, now),
          read_seconds: gainedS,
          chapters_completed: newlyCompleted ? 1 : 0,
        })
        .onConflict((oc) =>
          oc.columns(['user_id', 'day']).doUpdateSet((eb) => ({
            read_seconds: eb('novel_read_daily.read_seconds', '+', gainedS),
            chapters_completed: eb(
              'novel_read_daily.chapters_completed',
              '+',
              newlyCompleted ? 1 : 0,
            ),
            updated_at: now,
          })),
        )
        .execute();
    }

    await trx
      .updateTable('novel_read_progress')
      .set({
        read_time_s: readTimeS,
        max_scroll_ratio: scrollRatio.toFixed(3),
        last_heartbeat_at: now,
        ...(newlyCompleted ? { completed_at: now } : {}),
      })
      .where('id', '=', row.id)
      .execute();

    const rewardEligible = !vip && feature.enabled && feature.chapter_reward_coin > 0;
    const rewardedToday = await countRewardedToday(trx, userId, timezone, now);
    const remainingToday = Math.max(feature.chapter_reward_daily_cap - rewardedToday, 0);
    // Read on every beat so the reader can show "×2" while a boost runs, not only on the paying one.
    const boost = await activeBoost(trx, userId, now);
    const multiplier = boost?.multiplier ?? 1;
    const base = {
      read_seconds: readTimeS,
      required_seconds: requiredS,
      scroll_ratio: scrollRatio,
      reward_eligible: rewardEligible,
      boost_multiplier: multiplier,
    };
    const unpaid = {
      response: {
        ...base,
        rewarded: false,
        credited_coin: 0,
        new_balance: await currentBalance(trx, userId),
        daily_remaining: remainingToday,
      },
      regionId: null as string | null,
      mintedCoin: 0,
    };

    // All normal states, not client errors: this endpoint fires every few seconds under an open
    // chapter, and the app reads `rewarded`, not the status code.
    if (!rewardEligible || row.rewarded_at !== null || !complete || remainingToday <= 0) {
      return unpaid;
    }

    const rewardCoin = feature.chapter_reward_coin * multiplier;
    const ledger = await creditInTransaction(trx, {
      userId,
      entryType: 'NOVEL_READ_CREDIT',
      amount: rewardCoin,
      refType: 'novel_chapter',
      refId: chapter.id,
      // Keyed on the chapter, so even a duplicate progress row could never pay twice.
      idempotencyKey: `novel-read:${userId}:${chapter.id}`,
      note:
        multiplier > 1 ? `Chapter reading reward ×${String(multiplier)}` : 'Chapter reading reward',
    });
    await trx
      .updateTable('novel_read_progress')
      .set({ rewarded_at: now })
      .where('id', '=', row.id)
      .execute();
    if (ledger.deduped) return unpaid;

    return {
      response: {
        ...base,
        rewarded: true,
        credited_coin: rewardCoin,
        new_balance: ledger.balanceAfter,
        daily_remaining: Math.max(remainingToday - 1, 0),
      },
      regionId: ledger.regionId,
      mintedCoin: ledger.mintedAmount,
    };
  });

  // Best-effort and post-commit, and only for a credit that actually happened — same handling as
  // every other mint path.
  if (result.regionId && result.mintedCoin > 0) {
    void recordMint(result.regionId, result.mintedCoin).catch(() => undefined);
  }
  return result.response;
}
