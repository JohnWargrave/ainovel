import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import type { Transaction } from 'kysely';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { ensureOpenFraudFlag } from '../fraud/ensure-open-flag.js';
import { hasOpenFraudFlag } from '../fraud/has-open-flag.js';
import { recomputeScoreInTx } from '../fraud/score.service.js';
import { assignReferralCode } from './referral-code.js';
import { getReferralFeature } from './region-feature.js';
import type { ReferralStatsResponse } from './schemas.js';
import { shareUrl } from '../../lib/share-url.js';

const REDEEM_WINDOW_MS = 72 * 60 * 60 * 1000; // 11-REFERRAL.md §2: 72h onboarding window
const IP_CLUSTER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // RF02: 7-day window
const IP_CLUSTER_MIN_MATCHES = 3; // RF02: >=3 referees on the same /24
const RECENT_ACTIVITY_LIMIT = 5;

// IPv4-only, mirrors the codebase's existing geoip-lite/IP-intelligence scope (no ASN data source
// exists to be more precise, see evaluateReferralIpCluster's doc comment).
function ipv4Slash24(ip: string): string | null {
  const match = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip);
  return match?.[1] ?? null;
}

// RF02 (11-REFERRAL.md §3): >=3 of a referrer's own referees redeemed from the same IP/24 within 7
// days. Interpreted as "referees clustered with each other", not "with the referrer's own signup
// IP" — the referrer's signup IP was never captured (no code path exists for it), so that reading
// can't be implemented for referrers who signed up before this milestone.
//
// Known limitation, not fixed here: 16-ANTI-CHEAT-HARDENING.md §4 notes this flat ">=3" threshold
// produces false positives on mobile-carrier CGNAT (common in SEA) — an ASN-aware threshold would
// need a data source (MaxMind/IPinfo) this codebase doesn't have.
async function evaluateReferralIpCluster(
  trx: Transaction<DB>,
  referrerId: string,
  newIp: string,
): Promise<void> {
  const prefix = ipv4Slash24(newIp);
  if (!prefix) return;

  const rows = await trx
    .selectFrom('users')
    .select('referred_ip')
    .where('referred_by', '=', referrerId)
    .where('referred_ip', 'is not', null)
    .where('referred_by_set_at', '>=', new Date(Date.now() - IP_CLUSTER_WINDOW_MS))
    .execute();

  const matches = rows.filter(
    (row) => row.referred_ip !== null && ipv4Slash24(row.referred_ip) === prefix,
  ).length;
  if (matches < IP_CLUSTER_MIN_MATCHES) return;

  await ensureOpenFraudFlag(trx, referrerId, 'RF02', 3, { ip_prefix: prefix, matches });
  await recomputeScoreInTx(trx, referrerId);
}

// RF01 (11-REFERRAL.md §3, hard block like D01): device fingerprint collision is already structurally
// prevented by the devices_fingerprint_active unique index, so in practice this can only ever trigger
// on a shared GAID between the referrer's and referee's devices.
//
// Runs against plain `db` (not the caller's redeem transaction) on purpose, same reasoning as
// auth.service.ts's assertFingerprintFree: the fraud_flags insert must survive even though the
// redeem itself is aborted, and a transaction that throws rolls back everything it wrote — including
// a flag inserted earlier in that same transaction.
async function assertNoSharedGaid(referrerId: string, refereeId: string): Promise<void> {
  const sharedGaid = await db
    .selectFrom('devices as referrer_devices')
    .innerJoin('devices as referee_devices', (join) =>
      join.onRef('referrer_devices.gaid', '=', 'referee_devices.gaid'),
    )
    .select('referrer_devices.gaid')
    .where('referrer_devices.user_id', '=', referrerId)
    .where('referee_devices.user_id', '=', refereeId)
    .where('referrer_devices.gaid', 'is not', null)
    .executeTakeFirst();
  if (!sharedGaid) return;

  await db.transaction().execute(async (trx) => {
    await ensureOpenFraudFlag(trx, referrerId, 'RF01', 4, {
      referee_id: refereeId,
      gaid: sharedGaid.gaid,
    });
    await recomputeScoreInTx(trx, referrerId);
  });
  throw new AppError('REFERRAL_BLOCKED', 'Unable to apply this referral code', 409);
}

export async function redeemReferralCode(
  refereeId: string,
  rawCode: string,
  ip: string,
): Promise<void> {
  const code = rawCode.trim().toUpperCase();
  const referrer = await db
    .selectFrom('users')
    .select(['id', 'region_id'])
    .where('referral_code', '=', code)
    .executeTakeFirst();
  if (!referrer) {
    throw new AppError('REFERRAL_CODE_NOT_FOUND', 'Referral code not found', 404);
  }
  if (referrer.id === refereeId) {
    throw new AppError('REFERRAL_SELF_BLOCKED', 'Cannot redeem your own referral code', 400);
  }

  const referee = await db
    .selectFrom('users')
    .select('region_id')
    .where('id', '=', refereeId)
    .executeTakeFirst();
  if (!referee) {
    throw new AppError('USER_NOT_FOUND', 'User not found', 404);
  }
  const [refereeFeature, referrerFeature, referrerBlocked] = await Promise.all([
    getReferralFeature(referee.region_id),
    getReferralFeature(referrer.region_id),
    hasOpenFraudFlag(referrer.id, ['RF04']),
  ]);
  if (!refereeFeature.enabled || !referrerFeature.enabled) {
    throw new AppError('FEATURE_DISABLED', 'Referral is not enabled for this region', 404);
  }
  if (referrerBlocked) {
    throw new AppError('REFERRAL_BLOCKED', 'Unable to apply this referral code', 409);
  }
  await assertNoSharedGaid(referrer.id, refereeId);

  await db.transaction().execute(async (trx) => {
    const referee = await trx
      .selectFrom('users')
      .select(['id', 'referred_by', 'created_at'])
      .where('id', '=', refereeId)
      .forUpdate()
      .executeTakeFirst();
    if (!referee) {
      throw new AppError('USER_NOT_FOUND', 'User not found', 404);
    }
    if (referee.referred_by !== null) {
      throw new AppError('REFERRAL_ALREADY_SET', 'A referral code was already applied', 409);
    }
    if (Date.now() - new Date(referee.created_at).getTime() > REDEEM_WINDOW_MS) {
      throw new AppError('REFERRAL_WINDOW_EXPIRED', 'Referral redeem window has expired', 409);
    }

    const updated = await trx
      .updateTable('users')
      .set({ referred_by: referrer.id, referred_by_set_at: new Date(), referred_ip: ip })
      .where('id', '=', refereeId)
      .where('referred_by', 'is', null)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      throw new AppError('REFERRAL_ALREADY_SET', 'A referral code was already applied', 409);
    }

    await evaluateReferralIpCluster(trx, referrer.id, ip);
  });
}

// Every signup path issues a code (auth.service.ts createUserWithDevice), but rows created before
// that shipped still carry NULL and the Refer screen has nothing to share. Repair on read rather than
// only in a migration: a backfill fixes the rows that exist today, this fixes any that slip through
// (a restored dump, a manually inserted row) without a second incident.
async function ensureReferralCode(userId: string): Promise<{ code: string; regionId: string }> {
  const user = await db
    .selectFrom('users')
    // Region read here rather than via loadUserRegionFeatures: that helper 403s banned/suspended
    // accounts because it guards *earning*, and viewing your own referral stats is not earning.
    .select(['referral_code', 'region_id'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) {
    throw new AppError('USER_NOT_FOUND', 'User not found', 404);
  }
  if (user.referral_code) return { code: user.referral_code, regionId: user.region_id };

  const code = await db.transaction().execute(async (trx) => {
    // Re-read under FOR UPDATE: two concurrent /referral calls for the same legacy user would
    // otherwise both generate a code and the second would fail the UNIQUE constraint.
    const locked = await trx
      .selectFrom('users')
      .select('referral_code')
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (locked.referral_code) return locked.referral_code;

    const fresh = await assignReferralCode(trx);
    await trx.updateTable('users').set({ referral_code: fresh }).where('id', '=', userId).execute();
    return fresh;
  });
  return { code, regionId: user.region_id };
}

export async function getReferralStats(userId: string): Promise<ReferralStatsResponse> {
  const { code, regionId } = await ensureReferralCode(userId);
  const feature = await getReferralFeature(regionId);

  const applicationUser = await db
    .selectFrom('users')
    .select(['created_at', 'referred_by', 'referred_by_set_at'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  const expiresAt = new Date(new Date(applicationUser.created_at).getTime() + REDEEM_WINDOW_MS);
  const applicationStatus = applicationUser.referred_by
    ? 'applied'
    : Date.now() > expiresAt.getTime()
      ? 'expired'
      : 'eligible';

  const counts = await db
    .selectFrom('users')
    .select((eb) => [
      eb.fn.countAll<string>().as('total'),
      eb.fn
        .count<string>('id')
        .filterWhere('referral_qualified_at', 'is not', null)
        .as('qualified'),
    ])
    .where('referred_by', '=', userId)
    .executeTakeFirstOrThrow();
  const total = Number(counts.total);
  const qualified = Number(counts.qualified);

  const earned = await db
    .selectFrom('coin_ledger')
    .select((eb) => [
      eb.fn
        .coalesce(
          eb.fn.sum<string>('amount').filterWhere('entry_type', '=', 'REFERRAL_CREDIT'),
          eb.lit(0),
        )
        .as('credited'),
      eb.fn
        .coalesce(
          eb.fn.sum<string>('amount').filterWhere('entry_type', '=', 'REFERRAL_CLAWBACK'),
          eb.lit(0),
        )
        .as('clawed_back'),
    ])
    .where('user_id', '=', userId)
    .where('entry_type', 'in', ['REFERRAL_CREDIT', 'REFERRAL_CLAWBACK'])
    .executeTakeFirstOrThrow();
  const totalEarned = BigInt(earned.credited) + BigInt(earned.clawed_back);

  const recent = await db
    .selectFrom('coin_ledger')
    .select(['amount', 'created_at'])
    .where('user_id', '=', userId)
    .where('entry_type', '=', 'REFERRAL_CREDIT')
    .orderBy('id', 'desc')
    .limit(RECENT_ACTIVITY_LIMIT)
    .execute();

  const shareUrl = referralShareUrl(code);

  return {
    code,
    ...(shareUrl ? { share_url: shareUrl } : {}),
    total_referrals: total,
    qualified_referrals: qualified,
    pending_referrals: total - qualified,
    total_earned_coin: totalEarned.toString(),
    terms: {
      reward_pct: feature.pct,
      milestone_bonus_coin: feature.milestone_bonus_coin,
      milestone_bonus_threshold: feature.milestone_bonus_threshold,
      hold_hours: feature.hold_hours,
      credit_immediately: feature.credit_immediately,
    },
    recent_activity: recent.map((row) => ({
      coin: Number(row.amount),
      at: new Date(row.created_at).toISOString(),
    })),
    application: {
      status: applicationStatus,
      can_redeem: feature.enabled && applicationStatus === 'eligible',
      expires_at: applicationStatus === 'applied' ? null : expiresAt.toISOString(),
      applied_at: applicationUser.referred_by_set_at
        ? new Date(applicationUser.referred_by_set_at).toISOString()
        : null,
    },
  };
}

// Undefined when REFERRAL_SHARE_BASE_URL is unset or invalid — see the schema's note on why an
// absent field beats a broken link.
function referralShareUrl(code: string): string | undefined {
  return shareUrl(env.REFERRAL_SHARE_BASE_URL, code);
}
