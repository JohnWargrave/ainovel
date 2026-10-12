import { uuidv7 } from 'uuidv7';
import type { Kysely, Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { dayWindow } from '../../lib/day-window.js';
import {
  getPlacementFeature,
  getRewardedAdsFeature,
  type RewardedAdPlacement,
  type RewardedAdsFeature,
} from './region-feature.js';
import type { IntentResponse, RewardedAdStateResponse } from './schemas.js';

const INTENT_TTL_MS = 10 * 60 * 1000; // 04-POSTBACK-SPEC.md §7: intent must be consumed within 10 min

type QueryExecutor = Kysely<DB> | Transaction<DB>;

interface RewardedAdUser {
  region_id: string;
  status: string;
}

export interface IntentContext {
  /** The app's own IP. Captured here because the SSV callback's IP is Google's, not the user's. */
  ip: string;
}

function assertEarningAllowed(user: RewardedAdUser): void {
  if (user.status === 'banned') {
    throw new AppError('EARNING_BLOCKED', 'User is not in good standing to earn', 403);
  }
  if (user.status === 'suspended') {
    throw new AppError(
      'EARNING_SUSPENDED',
      'Earning is temporarily unavailable for this account',
      403,
    );
  }
}

export async function buildState(
  executor: QueryExecutor,
  userId: string,
  feature: RewardedAdsFeature,
  now: Date,
  placement: RewardedAdPlacement | null = null,
): Promise<RewardedAdStateResponse> {
  const window = dayWindow(feature.timezone, now);
  const limits = getPlacementFeature(feature, placement);
  // Quota is counted within the placement when one is named, and across the legacy shared bucket
  // when it is not. Rows with a NULL placement predate the column, so a placement-scoped count
  // deliberately excludes them rather than attributing them to whichever position is asking.
  const [credited, pending, lastIntent] = await Promise.all([
    executor
      .selectFrom('earning_events')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('user_id', '=', userId)
      .where('source', '=', 'admob_ssv')
      .where('created_at', '>=', window.start)
      .where('created_at', '<', window.end)
      .$if(placement !== null, (qb) => qb.where('placement', '=', placement))
      .executeTakeFirstOrThrow(),
    // A pending intent is a reservation against *today's* quota. Bounding it to the same window as
    // the credited count keeps an intent minted at 23:55 local from holding a slot after midnight —
    // it can still be redeemed (SSV honours any unexpired intent), it just bills the day it lands in.
    executor
      .selectFrom('rewarded_ad_intents')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('user_id', '=', userId)
      .where('status', '=', 'pending')
      .where('expires_at', '>', now)
      .where('created_at', '>=', window.start)
      .where('created_at', '<', window.end)
      .$if(placement !== null, (qb) => qb.where('placement', '=', placement))
      .executeTakeFirstOrThrow(),
    executor
      .selectFrom('rewarded_ad_intents')
      .select('created_at')
      .where('user_id', '=', userId)
      .$if(placement !== null, (qb) => qb.where('placement', '=', placement))
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
  ]);
  const rewardsToday = Number(credited.count);
  const pendingRewards = Number(pending.count);
  const nextAvailable =
    lastIntent && limits.cooldown_s > 0
      ? new Date(new Date(lastIntent.created_at).getTime() + limits.cooldown_s * 1000)
      : null;

  return {
    enabled: feature.enabled,
    placement,
    daily_cap: limits.daily_cap,
    rewards_today: rewardsToday,
    pending_rewards: pendingRewards,
    rewards_remaining: Math.max(0, limits.daily_cap - rewardsToday - pendingRewards),
    cooldown_s: limits.cooldown_s,
    next_available_at: nextAvailable && nextAvailable > now ? nextAvailable.toISOString() : null,
    reset_at: window.end.toISOString(),
  };
}

export async function getRewardedAdState(
  userId: string,
  placement: RewardedAdPlacement | null = null,
  now = new Date(),
): Promise<RewardedAdStateResponse> {
  const user = await db
    .selectFrom('users')
    .select(['region_id', 'status'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw new AppError('USER_NOT_FOUND', `No user ${userId}`, 404);
  assertEarningAllowed(user);
  const feature = await getRewardedAdsFeature(user.region_id);
  return buildState(db, userId, feature, now, placement);
}

// 05-FRAUD-ENGINE.md §1 checkpoint "Rewarded ad intent | Cap, cooldown, integrity gần nhất | Từ chối
// intent". "Integrity gần nhất" is read as users.status/fraud_score — the columns the users table
// comment already documents as "cached từ fraud engine" — rather than a fresh device-level check:
// there is no way to map the current request (JWT only carries {sub, trust_level}) to a specific
// devices row, since x-device-id is validated only on signup/login routes today, nowhere else.
export async function createIntent(
  userId: string,
  context: IntentContext,
  placement: RewardedAdPlacement | null = null,
): Promise<IntentResponse> {
  const now = new Date();
  return db.transaction().execute(async (trx) => {
    // The user row serializes quota reservations for concurrent intent requests from one account.
    const user = await trx
      .selectFrom('users')
      .select(['region_id', 'status', 'country_code'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!user) throw new AppError('USER_NOT_FOUND', `No user ${userId}`, 404);
    assertEarningAllowed(user);

    const feature = await getRewardedAdsFeature(user.region_id);
    if (!feature.enabled) {
      throw new AppError('FEATURE_DISABLED', 'Rewarded ads are not enabled for this region', 404);
    }
    const state = await buildState(trx, userId, feature, now, placement);
    if (state.rewards_remaining <= 0) {
      throw new AppError('DAILY_CAP_REACHED', 'Rewarded ad daily cap reached', 429);
    }
    if (state.next_available_at) {
      throw new AppError('COOLDOWN_ACTIVE', 'Cooldown between rewarded ads is still active', 429);
    }

    const id = uuidv7();
    await trx
      .insertInto('rewarded_ad_intents')
      .values({
        id,
        user_id: userId,
        region_id: user.region_id,
        expires_at: new Date(now.getTime() + INTENT_TTL_MS),
        ip_at_intent: context.ip,
        geo_at_intent: user.country_code,
        placement,
      })
      .execute();

    return {
      intent_id: id,
      ssv_custom_data: id,
      state: {
        ...state,
        pending_rewards: state.pending_rewards + 1,
        rewards_remaining: Math.max(0, state.rewards_remaining - 1),
        next_available_at:
          state.cooldown_s > 0
            ? new Date(now.getTime() + state.cooldown_s * 1000).toISOString()
            : null,
      },
    };
  });
}
