import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { credit } from '../../src/modules/wallet-ledger/ledger.service.js';
import { assignReferralCode } from '../../src/modules/referral/referral-code.js';
import {
  getReferralStats,
  redeemReferralCode,
} from '../../src/modules/referral/referral.service.js';
import {
  evaluateReferralClawbackRate,
  processReferralCredit,
  propagateReferralClawback,
} from '../../src/modules/referral/referral-credit.service.js';

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

interface ErrorResponseBody {
  error: { code: string; message: string };
}

interface AuthResponseBody {
  access: string;
  user: { id: string; referral_code: string | null };
}

interface ReferralStatsResponseBody {
  code: string;
  share_url?: string;
  total_referrals: number;
  qualified_referrals: number;
  pending_referrals: number;
  total_earned_coin: string;
  terms: {
    reward_pct: number;
    milestone_bonus_coin: number;
    milestone_bonus_threshold: number;
    hold_hours: number;
    credit_immediately: boolean;
  };
  recent_activity: { coin: number; at: string }[];
  application: {
    status: 'eligible' | 'applied' | 'expired';
    can_redeem: boolean;
    expires_at: string | null;
    applied_at: string | null;
  };
}

const DEFAULT_REFERRAL_FEATURE = {
  enabled: true,
  pct: 0.1,
  duration_months: null,
  milestone_bonus_coin: 0,
  milestone_bonus_threshold: 50_000,
  hold_hours: 0,
  credit_immediately: false,
};

async function createReferralRegion(
  regionId: string,
  referral: Record<string, unknown> = DEFAULT_REFERRAL_FEATURE,
): Promise<void> {
  await db
    .insertInto('region_config')
    .values({ region_id: regionId, countries: [], features: { referral } })
    .execute();
}

// Direct-insert fixture (no HTTP signup, no auth-guest rate limit involvement) — every test below
// except the code-generation test uses this, mirroring the rest of the codebase's own convention of
// only exercising the real /auth/guest route from auth.test.ts itself.
async function createReferralUser(overrides?: {
  gaid?: string;
  createdAt?: Date;
  regionId?: string;
}): Promise<{ userId: string; referralCode: string; gaid: string }> {
  const userId = uuidv7();
  const referralCode = await db.transaction().execute((trx) => assignReferralCode(trx));
  await db
    .insertInto('users')
    .values({
      id: userId,
      auth_provider: 'guest',
      auth_subject: `test-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: overrides?.regionId ?? 'VN',
      referral_code: referralCode,
      ...(overrides?.createdAt ? { created_at: overrides.createdAt } : {}),
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId }).execute();
  const gaid = overrides?.gaid ?? randomUUID();
  await db
    .insertInto('devices')
    .values({ id: uuidv7(), user_id: userId, fingerprint_hash: randomUUID(), gaid })
    .execute();
  return { userId, referralCode, gaid };
}

// Inserts a real coin_ledger row (via the real credit() primitive) plus the matching earning_events
// row it's linked to, mirroring what postback.service.ts / ssv.service.ts actually write for a backed
// credit — processReferralCredit reads both, so a synthetic row must have the same shape as the real
// thing rather than just the earning_events half.
async function insertBackedEvent(
  userId: string,
  opts: {
    entryType: 'OFFERWALL_CREDIT' | 'REWARDED_AD_CREDIT';
    coin: number;
    payoutUsd: number;
    bucket?: 'available' | 'pending';
    holdUntil?: Date;
    status?: 'credited' | 'clawed_back';
  },
): Promise<string> {
  const eventId = uuidv7();
  await db
    .insertInto('earning_events')
    .values({
      id: eventId,
      user_id: userId,
      device_id: null,
      source: opts.entryType === 'OFFERWALL_CREDIT' ? 'tapjoy' : 'admob_ssv',
      network_tx_id: randomUUID(),
      payout_usd: String(opts.payoutUsd),
      coin_awarded: opts.coin,
      share_applied: null,
      geo_at_event: null,
      ip_at_event: null,
      status: opts.status ?? 'credited',
      raw_payload: JSON.stringify({}),
    })
    .execute();
  await credit({
    userId,
    entryType: opts.entryType,
    amount: opts.coin,
    ...(opts.bucket === 'pending'
      ? {
          bucket: 'pending' as const,
          holdUntil: opts.holdUntil ?? new Date(Date.now() + 48 * 60 * 60 * 1000),
        }
      : {}),
    refType: 'earning_event',
    refId: eventId,
    idempotencyKey: `test:${eventId}`,
    revenueUsd: opts.payoutUsd,
  });
  return eventId;
}

// Gives the referee a WELCOME_CREDIT row (the qualification proxy processReferralCredit checks) plus
// a first backed event, matching real signup + first-offer behavior.
async function qualify(userId: string): Promise<string> {
  await credit({
    userId,
    entryType: 'WELCOME_CREDIT',
    amount: 10_000,
    idempotencyKey: `welcome:test:${userId}`,
    note: 'test fixture welcome bonus',
  });
  return insertBackedEvent(userId, { entryType: 'OFFERWALL_CREDIT', coin: 1000, payoutUsd: 0.5 });
}

describe('referral', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;

  beforeAll(async () => {
    app = await buildApp();
    accessJwt = (app.jwt as unknown as { access: JWT }).access;
  });

  afterAll(async () => {
    await app.close();
  });

  function tokenFor(userId: string): string {
    return accessJwt.sign({ sub: userId, trust_level: 0 });
  }

  it('returns a unique HP-XXXXXX referral code, including through signup', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers: { ...APP_HEADERS, 'x-device-id': randomUUID() },
      payload: {
        device: {
          gaid: randomUUID(),
          model: 'Pixel-Test',
          os: 'Android 14',
        },
      },
    });
    const signedUp = res.json<AuthResponseBody>();
    expect(signedUp.user.referral_code).toMatch(/^HP-[A-Z0-9]{6}$/);

    const codes = await db.transaction().execute(async (trx) => {
      const a = await assignReferralCode(trx);
      await trx
        .insertInto('users')
        .values({
          id: uuidv7(),
          auth_provider: 'guest',
          auth_subject: `test-${randomUUID()}`,
          email: null,
          country_code: 'VN',
          region_id: 'VN',
          referral_code: a,
        })
        .execute();
      const b = await assignReferralCode(trx);
      return { a, b };
    });
    expect(codes.a).toMatch(/^HP-[A-Z0-9]{6}$/);
    expect(codes.b).toMatch(/^HP-[A-Z0-9]{6}$/);
    expect(codes.a).not.toBe(codes.b);
  });

  it('issues a code on read for a legacy row that has none', async () => {
    // Rows created before signup-time assignment shipped carry NULL, which returned `code: null` and
    // left the Refer screen with nothing to share. Reproduced by nulling the column directly.
    const user = await createReferralUser();
    await db
      .updateTable('users')
      .set({ referral_code: null })
      .where('id', '=', user.userId)
      .execute();

    const stats = await getReferralStats(user.userId);
    expect(stats.code).toMatch(/^HP-[A-Z0-9]{6}$/);

    // Persisted, not generated fresh per request — an invite code that changed between reads would
    // invalidate every link the user had already shared.
    const persisted = await db
      .selectFrom('users')
      .select('referral_code')
      .where('id', '=', user.userId)
      .executeTakeFirstOrThrow();
    expect(persisted.referral_code).toBe(stats.code);
    expect((await getReferralStats(user.userId)).code).toBe(stats.code);
  });

  it('reports the referral terms so the app does not hardcode them', async () => {
    const regionId = `REF_${randomUUID()}`;
    await createReferralRegion(regionId);
    const user = await createReferralUser({ regionId });

    const stats = await getReferralStats(user.userId);
    expect(stats.terms).toEqual({
      reward_pct: DEFAULT_REFERRAL_FEATURE.pct,
      milestone_bonus_coin: DEFAULT_REFERRAL_FEATURE.milestone_bonus_coin,
      milestone_bonus_threshold: DEFAULT_REFERRAL_FEATURE.milestone_bonus_threshold,
      hold_hours: DEFAULT_REFERRAL_FEATURE.hold_hours,
      credit_immediately: DEFAULT_REFERRAL_FEATURE.credit_immediately,
    });
    expect(stats.share_url).toBe(`https://links.ainovel.test/r/${stats.code}`);
    expect(stats.application.status).toBe('eligible');
    expect(stats.application.can_redeem).toBe(true);
    expect(stats.application.expires_at).not.toBeNull();
  });

  it('sets referred_by once and rejects a second redeem', async () => {
    const regionId = `REF_${randomUUID()}`;
    await createReferralRegion(regionId);
    const referrer = await createReferralUser({ regionId });
    const referee = await createReferralUser({ regionId });

    await redeemReferralCode(referee.userId, referrer.referralCode, '203.0.113.50');
    const user = await db
      .selectFrom('users')
      .select('referred_by')
      .where('id', '=', referee.userId)
      .executeTakeFirstOrThrow();
    expect(user.referred_by).toBe(referrer.userId);

    const appliedStats = await getReferralStats(referee.userId);
    expect(appliedStats.application.status).toBe('applied');
    expect(appliedStats.application.can_redeem).toBe(false);
    expect(appliedStats.application.expires_at).toBeNull();
    expect(appliedStats.application.applied_at).not.toBeNull();

    await expect(
      redeemReferralCode(referee.userId, referrer.referralCode, '203.0.113.51'),
    ).rejects.toMatchObject({ code: 'REFERRAL_ALREADY_SET' });
  });

  it('rejects redeem after the 72h window', async () => {
    const referrer = await createReferralUser();
    const referee = await createReferralUser({
      createdAt: new Date(Date.now() - 73 * 60 * 60 * 1000),
    });

    await expect(
      redeemReferralCode(referee.userId, referrer.referralCode, '203.0.113.52'),
    ).rejects.toMatchObject({ code: 'REFERRAL_WINDOW_EXPIRED' });
    const stats = await getReferralStats(referee.userId);
    expect(stats.application.status).toBe('expired');
    expect(stats.application.can_redeem).toBe(false);
    expect(stats.application.expires_at).not.toBeNull();
    expect(stats.application.applied_at).toBeNull();
  });

  it('rejects redeeming your own referral code', async () => {
    const user = await createReferralUser();
    await expect(
      redeemReferralCode(user.userId, user.referralCode, '203.0.113.53'),
    ).rejects.toMatchObject({ code: 'REFERRAL_SELF_BLOCKED' });
  });

  it('rejects an unknown referral code', async () => {
    const user = await createReferralUser();
    await expect(
      redeemReferralCode(user.userId, 'HP-ZZZZZZ', '203.0.113.54'),
    ).rejects.toMatchObject({ code: 'REFERRAL_CODE_NOT_FOUND' });
  });

  it('RF01: blocks redeem when referrer and referee share a device GAID', async () => {
    const sharedGaid = randomUUID();
    const referrer = await createReferralUser({ gaid: sharedGaid });
    const referee = await createReferralUser({ gaid: sharedGaid });

    await expect(
      redeemReferralCode(referee.userId, referrer.referralCode, '203.0.113.55'),
    ).rejects.toMatchObject({ code: 'REFERRAL_BLOCKED' });

    const user = await db
      .selectFrom('users')
      .select('referred_by')
      .where('id', '=', referee.userId)
      .executeTakeFirstOrThrow();
    expect(user.referred_by).toBeNull();

    const flags = await db
      .selectFrom('fraud_flags')
      .selectAll()
      .where('user_id', '=', referrer.userId)
      .where('rule_code', '=', 'RF01')
      .execute();
    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe(4);
  });

  it('qualifies the referee on their first backed event >= $0.10 without spawning a credit for it', async () => {
    const regionId = `REF_${randomUUID()}`;
    await createReferralRegion(regionId);
    const referrer = await createReferralUser({ regionId });
    const referee = await createReferralUser({ regionId });
    await redeemReferralCode(referee.userId, referrer.referralCode, '203.0.113.60');

    const eventId = await qualify(referee.userId);
    await processReferralCredit({
      earningEventId: eventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });

    const user = await db
      .selectFrom('users')
      .select('referral_qualified_at')
      .where('id', '=', referee.userId)
      .executeTakeFirstOrThrow();
    expect(user.referral_qualified_at).not.toBeNull();

    const credits = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('user_id', '=', referrer.userId)
      .where('entry_type', '=', 'REFERRAL_CREDIT')
      .execute();
    expect(credits).toHaveLength(0);
  });

  it('credits REFERRAL_CREDIT mirroring the original bucket/hold for OFFERWALL_CREDIT and REWARDED_AD_CREDIT', async () => {
    const regionId = `REF_${randomUUID()}`;
    await createReferralRegion(regionId);
    const referrer = await createReferralUser({ regionId });
    const referee = await createReferralUser({ regionId });
    await redeemReferralCode(referee.userId, referrer.referralCode, '203.0.113.61');
    const qualifyingEventId = await qualify(referee.userId);
    await processReferralCredit({
      earningEventId: qualifyingEventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });

    const holdUntil = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const offerwallEventId = await insertBackedEvent(referee.userId, {
      entryType: 'OFFERWALL_CREDIT',
      coin: 1000,
      payoutUsd: 0.5,
      bucket: 'pending',
      holdUntil,
    });
    await processReferralCredit({
      earningEventId: offerwallEventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });
    const offerwallCredit = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('ref_type', '=', 'earning_event')
      .where('ref_id', '=', offerwallEventId)
      .where('entry_type', '=', 'REFERRAL_CREDIT')
      .executeTakeFirstOrThrow();
    expect(offerwallCredit.bucket).toBe('pending');
    expect(offerwallCredit.amount).toBe('100');
    expect(new Date(offerwallCredit.hold_until ?? 0).getTime()).toBeCloseTo(
      holdUntil.getTime(),
      -2,
    );

    const ssvEventId = await insertBackedEvent(referee.userId, {
      entryType: 'REWARDED_AD_CREDIT',
      coin: 50,
      payoutUsd: 0.01,
    });
    await processReferralCredit({
      earningEventId: ssvEventId,
      refereeId: referee.userId,
      entryType: 'REWARDED_AD_CREDIT',
    });
    const ssvCredit = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('ref_type', '=', 'earning_event')
      .where('ref_id', '=', ssvEventId)
      .where('entry_type', '=', 'REFERRAL_CREDIT')
      .executeTakeFirstOrThrow();
    expect(ssvCredit.bucket).toBe('available');
    expect(ssvCredit.hold_until).toBeNull();
    expect(ssvCredit.amount).toBe('5');
  });

  it('applies the configured referral wait without shortening the source hold', async () => {
    const regionId = `REF_${randomUUID()}`;
    await createReferralRegion(regionId, { ...DEFAULT_REFERRAL_FEATURE, hold_hours: 12 });
    const referrer = await createReferralUser({ regionId });
    const referee = await createReferralUser({ regionId });
    await redeemReferralCode(referee.userId, referrer.referralCode, '203.0.113.64');
    const qualifyingEventId = await qualify(referee.userId);
    await processReferralCredit({
      earningEventId: qualifyingEventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });

    const beforeRewarded = Date.now();
    const rewardedEventId = await insertBackedEvent(referee.userId, {
      entryType: 'REWARDED_AD_CREDIT',
      coin: 1_000,
      payoutUsd: 0.5,
    });
    await processReferralCredit({
      earningEventId: rewardedEventId,
      refereeId: referee.userId,
      entryType: 'REWARDED_AD_CREDIT',
    });
    const rewardedCredit = await db
      .selectFrom('coin_ledger')
      .select(['bucket', 'hold_until'])
      .where('user_id', '=', referrer.userId)
      .where('ref_id', '=', rewardedEventId)
      .where('entry_type', '=', 'REFERRAL_CREDIT')
      .executeTakeFirstOrThrow();
    expect(rewardedCredit.bucket).toBe('pending');
    expect(rewardedCredit.hold_until?.getTime()).toBeGreaterThanOrEqual(
      beforeRewarded + 12 * 60 * 60 * 1000,
    );
    expect(rewardedCredit.hold_until?.getTime()).toBeLessThanOrEqual(
      Date.now() + 12 * 60 * 60 * 1000,
    );

    const sourceHold = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const offerEventId = await insertBackedEvent(referee.userId, {
      entryType: 'OFFERWALL_CREDIT',
      coin: 1_000,
      payoutUsd: 0.5,
      bucket: 'pending',
      holdUntil: sourceHold,
    });
    await processReferralCredit({
      earningEventId: offerEventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });
    const offerCredit = await db
      .selectFrom('coin_ledger')
      .select(['bucket', 'hold_until'])
      .where('user_id', '=', referrer.userId)
      .where('ref_id', '=', offerEventId)
      .where('entry_type', '=', 'REFERRAL_CREDIT')
      .executeTakeFirstOrThrow();
    expect(offerCredit.bucket).toBe('pending');
    expect(offerCredit.hold_until?.getTime()).toBe(sourceHold.getTime());
  });

  it('credits referral coin immediately even when the source offerwall coin is pending', async () => {
    const regionId = `REF_${randomUUID()}`;
    await createReferralRegion(regionId, {
      ...DEFAULT_REFERRAL_FEATURE,
      hold_hours: 24,
      credit_immediately: true,
    });
    const referrer = await createReferralUser({ regionId });
    const referee = await createReferralUser({ regionId });
    await redeemReferralCode(referee.userId, referrer.referralCode, '203.0.113.72');
    const qualifyingEventId = await qualify(referee.userId);
    await processReferralCredit({
      earningEventId: qualifyingEventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });

    const eventId = await insertBackedEvent(referee.userId, {
      entryType: 'OFFERWALL_CREDIT',
      coin: 1_000,
      payoutUsd: 0.5,
      bucket: 'pending',
      holdUntil: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });
    await processReferralCredit({
      earningEventId: eventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });

    const referralCredit = await db
      .selectFrom('coin_ledger')
      .select(['bucket', 'hold_until'])
      .where('user_id', '=', referrer.userId)
      .where('ref_id', '=', eventId)
      .where('entry_type', '=', 'REFERRAL_CREDIT')
      .executeTakeFirstOrThrow();
    expect(referralCredit).toMatchObject({ bucket: 'available', hold_until: null });

    const wallet = await db
      .selectFrom('wallets')
      .select(['available_coin', 'pending_coin'])
      .where('user_id', '=', referrer.userId)
      .executeTakeFirstOrThrow();
    expect(wallet).toMatchObject({ available_coin: '100', pending_coin: '0' });
  });

  it('clamps the referrer credit at the MAX_TOTAL_SHARE invariant', async () => {
    const regionId = `REF_${randomUUID()}`;
    await createReferralRegion(regionId);
    const referrer = await createReferralUser({ regionId });
    const referee = await createReferralUser({ regionId });
    await redeemReferralCode(referee.userId, referrer.referralCode, '203.0.113.62');
    const qualifyingEventId = await qualify(referee.userId);
    await processReferralCredit({
      earningEventId: qualifyingEventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });

    // payoutUsd=1 -> maxTotal = floor(1 * 10000 * 0.6) = 6000; refereeCoin=5900 leaves only 100 of
    // headroom, well under the uncapped 10% (590) the pct alone would produce.
    const eventId = await insertBackedEvent(referee.userId, {
      entryType: 'OFFERWALL_CREDIT',
      coin: 5900,
      payoutUsd: 1,
    });
    await processReferralCredit({
      earningEventId: eventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });
    const referralCredit = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('ref_type', '=', 'earning_event')
      .where('ref_id', '=', eventId)
      .where('entry_type', '=', 'REFERRAL_CREDIT')
      .executeTakeFirstOrThrow();
    expect(referralCredit.amount).toBe('100');
  });

  it('propagates a clawback when the original earning event is reversed', async () => {
    const regionId = `REF_${randomUUID()}`;
    await createReferralRegion(regionId);
    const referrer = await createReferralUser({ regionId });
    const referee = await createReferralUser({ regionId });
    await redeemReferralCode(referee.userId, referrer.referralCode, '203.0.113.63');
    const qualifyingEventId = await qualify(referee.userId);
    await processReferralCredit({
      earningEventId: qualifyingEventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });

    const eventId = await insertBackedEvent(referee.userId, {
      entryType: 'OFFERWALL_CREDIT',
      coin: 1000,
      payoutUsd: 0.5,
      bucket: 'pending',
    });
    await processReferralCredit({
      earningEventId: eventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });

    await db.transaction().execute(async (trx) => {
      const propagated = await propagateReferralClawback(trx, eventId);
      expect(propagated?.referrerId).toBe(referrer.userId);
    });

    const clawback = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('ref_type', '=', 'earning_event')
      .where('ref_id', '=', eventId)
      .where('entry_type', '=', 'REFERRAL_CLAWBACK')
      .executeTakeFirstOrThrow();
    expect(clawback.amount).toBe('-100');
    const canceledCredit = await db
      .selectFrom('coin_ledger')
      .select('hold_until')
      .where('ref_type', '=', 'earning_event')
      .where('ref_id', '=', eventId)
      .where('entry_type', '=', 'REFERRAL_CREDIT')
      .executeTakeFirstOrThrow();
    expect(canceledCredit.hold_until).toBeNull();
  });

  it('RF02: freezes referral credit after >=3 referees redeem from the same /24 within 7 days', async () => {
    const regionId = `REF_${randomUUID()}`;
    await createReferralRegion(regionId);
    const referrer = await createReferralUser({ regionId });

    for (const suffix of ['10', '11', '12']) {
      const referee = await createReferralUser({ regionId });
      await redeemReferralCode(referee.userId, referrer.referralCode, `198.51.100.${suffix}`);
    }

    const flags = await db
      .selectFrom('fraud_flags')
      .selectAll()
      .where('user_id', '=', referrer.userId)
      .where('rule_code', '=', 'RF02')
      .where('status', '=', 'open')
      .execute();
    expect(flags).toHaveLength(1);

    const referee = await createReferralUser({ regionId });
    await redeemReferralCode(referee.userId, referrer.referralCode, '198.51.100.13');
    const qualifyingEventId = await qualify(referee.userId);
    await processReferralCredit({
      earningEventId: qualifyingEventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });
    const eventId = await insertBackedEvent(referee.userId, {
      entryType: 'OFFERWALL_CREDIT',
      coin: 1000,
      payoutUsd: 0.5,
    });
    await processReferralCredit({
      earningEventId: eventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });
    const frozenCredit = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('ref_type', '=', 'earning_event')
      .where('ref_id', '=', eventId)
      .where('entry_type', '=', 'REFERRAL_CREDIT')
      .executeTakeFirstOrThrow();
    expect(frozenCredit.bucket).toBe('pending');
    expect(new Date(frozenCredit.hold_until ?? 0).getFullYear()).toBe(2099);

    // The actual freeze protection is that hold-release.ts's periodic sweep only ever selects rows
    // matching `hold_until <= now()` — a 2099 sentinel structurally never matches, so this row is
    // never picked up for release. Assert against that exact filter rather than calling releaseHold
    // directly, since releaseHold(id) itself doesn't re-check hold_until against now() when invoked
    // by id — that gate lives entirely in the sweep's WHERE clause.
    const dueForRelease = await db
      .selectFrom('coin_ledger')
      .select('id')
      .where('id', '=', frozenCredit.id)
      .where('bucket', '=', 'pending')
      .where('hold_until', 'is not', null)
      .where('hold_until', '<=', new Date())
      .executeTakeFirst();
    expect(dueForRelease).toBeUndefined();
  });

  it('RF04: disables referral once >30% of qualified referees are clawed back', async () => {
    const regionId = `REF_${randomUUID()}`;
    await createReferralRegion(regionId);
    const referrer = await createReferralUser({ regionId });
    // Start above the floor so the RF04 decrement is actually observable (GREATEST(x-1,0) is a no-op
    // once already at 0).
    await db
      .updateTable('users')
      .set({ trust_level: 2 })
      .where('id', '=', referrer.userId)
      .execute();

    const ipPrefixes = ['203.0.113', '198.51.100', '192.0.2', '10.10.10', '10.10.11'];
    const refereeIds: string[] = [];
    for (const prefix of ipPrefixes) {
      const referee = await createReferralUser({ regionId });
      await redeemReferralCode(referee.userId, referrer.referralCode, `${prefix}.20`);
      const eventId = await qualify(referee.userId);
      await processReferralCredit({
        earningEventId: eventId,
        refereeId: referee.userId,
        entryType: 'OFFERWALL_CREDIT',
      });
      refereeIds.push(referee.userId);
    }

    // 2/5 = 40% > 30% threshold.
    await db
      .updateTable('earning_events')
      .set({ status: 'clawed_back' })
      .where('user_id', 'in', [refereeIds[0]!, refereeIds[1]!])
      .execute();

    await evaluateReferralClawbackRate(referrer.userId);

    const flags = await db
      .selectFrom('fraud_flags')
      .selectAll()
      .where('user_id', '=', referrer.userId)
      .where('rule_code', '=', 'RF04')
      .where('status', '=', 'open')
      .execute();
    expect(flags).toHaveLength(1);

    const user = await db
      .selectFrom('users')
      .select('trust_level')
      .where('id', '=', referrer.userId)
      .executeTakeFirstOrThrow();
    expect(user.trust_level).toBe(1);

    const blockedReferee = await createReferralUser({ regionId });
    await expect(
      redeemReferralCode(blockedReferee.userId, referrer.referralCode, '203.0.113.99'),
    ).rejects.toMatchObject({ code: 'REFERRAL_BLOCKED' });

    const eventId = await insertBackedEvent(refereeIds[2]!, {
      entryType: 'OFFERWALL_CREDIT',
      coin: 1000,
      payoutUsd: 0.5,
    });
    await processReferralCredit({
      earningEventId: eventId,
      refereeId: refereeIds[2]!,
      entryType: 'OFFERWALL_CREDIT',
    });
    const credits = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('ref_type', '=', 'earning_event')
      .where('ref_id', '=', eventId)
      .where('entry_type', '=', 'REFERRAL_CREDIT')
      .execute();
    expect(credits).toHaveLength(0);
  });

  it('awards the milestone bonus exactly once when the referee crosses the lifetime backed-coin threshold', async () => {
    const regionId = `REF_${randomUUID()}`;
    await createReferralRegion(regionId, {
      ...DEFAULT_REFERRAL_FEATURE,
      milestone_bonus_coin: 2000,
      milestone_bonus_threshold: 5000,
    });
    const referrer = await createReferralUser({ regionId });
    const referee = await createReferralUser({ regionId });
    await redeemReferralCode(referee.userId, referrer.referralCode, '203.0.113.70');
    const qualifyingEventId = await qualify(referee.userId); // 1000 lifetime coin so far
    await processReferralCredit({
      earningEventId: qualifyingEventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });

    const belowEventId = await insertBackedEvent(referee.userId, {
      entryType: 'OFFERWALL_CREDIT',
      coin: 2000, // lifetime now 3000, still below 5000
      payoutUsd: 1,
    });
    await processReferralCredit({
      earningEventId: belowEventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });
    const noBonusYet = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('ref_type', '=', 'referral_milestone')
      .where('ref_id', '=', referee.userId)
      .execute();
    expect(noBonusYet).toHaveLength(0);

    const crossingEventId = await insertBackedEvent(referee.userId, {
      entryType: 'OFFERWALL_CREDIT',
      coin: 3000, // lifetime now 6000, crosses 5000
      payoutUsd: 1,
    });
    await processReferralCredit({
      earningEventId: crossingEventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });

    const afterFirstCross = await insertBackedEvent(referee.userId, {
      entryType: 'OFFERWALL_CREDIT',
      coin: 100,
      payoutUsd: 0.5,
    });
    await processReferralCredit({
      earningEventId: afterFirstCross,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });

    const bonuses = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('ref_type', '=', 'referral_milestone')
      .where('ref_id', '=', referee.userId)
      .execute();
    expect(bonuses).toHaveLength(1);
    expect(bonuses[0]?.amount).toBe('2000');
  });

  it('GET /referral/stats returns totals and up to 5 anonymized recent activities', async () => {
    const regionId = `REF_${randomUUID()}`;
    await createReferralRegion(regionId);
    const referrer = await createReferralUser({ regionId });
    const referee = await createReferralUser({ regionId });
    await redeemReferralCode(referee.userId, referrer.referralCode, '203.0.113.71');
    const qualifyingEventId = await qualify(referee.userId);
    await processReferralCredit({
      earningEventId: qualifyingEventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });
    const eventId = await insertBackedEvent(referee.userId, {
      entryType: 'OFFERWALL_CREDIT',
      coin: 1000,
      payoutUsd: 0.5,
    });
    await processReferralCredit({
      earningEventId: eventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });

    const viaService = await getReferralStats(referrer.userId);
    expect(viaService.total_referrals).toBe(1);
    expect(viaService.qualified_referrals).toBe(1);
    expect(viaService.pending_referrals).toBe(0);
    expect(viaService.total_earned_coin).toBe('100');
    expect(viaService.recent_activity.length).toBeLessThanOrEqual(5);
    expect(viaService.recent_activity[0]?.coin).toBe(100);

    const res = await app.inject({
      method: 'GET',
      url: '/referral/stats',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(referrer.userId)}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ReferralStatsResponseBody>();
    expect(body.total_referrals).toBe(1);
    expect(JSON.stringify(body)).not.toContain(referee.userId);
  });

  it('exposes /v1/referral/redeem and /v1/referral/stats aliases', async () => {
    const referrer = await createReferralUser();
    const referee = await createReferralUser();

    const redeemRes = await app.inject({
      method: 'POST',
      url: '/v1/referral/redeem',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(referee.userId)}` },
      payload: { code: referrer.referralCode },
    });
    expect(redeemRes.statusCode).toBe(200);
    expect(redeemRes.json()).toEqual({ ok: true });

    const statsRes = await app.inject({
      method: 'GET',
      url: '/v1/referral/stats',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(referrer.userId)}` },
    });
    expect(statsRes.statusCode).toBe(200);
  });

  it('does not credit anything when the region feature is disabled', async () => {
    const regionId = `REF_${randomUUID()}`;
    await createReferralRegion(regionId, { ...DEFAULT_REFERRAL_FEATURE, enabled: false });
    const referrer = await createReferralUser({ regionId });
    const referee = await createReferralUser({ regionId });

    const stats = await getReferralStats(referee.userId);
    expect(stats.application.status).toBe('eligible');
    expect(stats.application.can_redeem).toBe(false);
    await expect(
      redeemReferralCode(referee.userId, referrer.referralCode, '203.0.113.80'),
    ).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });

    // Bypass the redeem gate to verify the credit processor independently keeps its own guard.
    await db
      .updateTable('users')
      .set({
        referred_by: referrer.userId,
        referred_by_set_at: new Date(),
        referred_ip: '203.0.113.80',
      })
      .where('id', '=', referee.userId)
      .execute();

    const eventId = await qualify(referee.userId);
    await processReferralCredit({
      earningEventId: eventId,
      refereeId: referee.userId,
      entryType: 'OFFERWALL_CREDIT',
    });

    const user = await db
      .selectFrom('users')
      .select('referral_qualified_at')
      .where('id', '=', referee.userId)
      .executeTakeFirstOrThrow();
    expect(user.referral_qualified_at).toBeNull();

    const credits = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('user_id', '=', referrer.userId)
      .where('entry_type', '=', 'REFERRAL_CREDIT')
      .execute();
    expect(credits).toHaveLength(0);
  });

  it('requires app headers on referral routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/referral/stats' });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorResponseBody>().error.code).toBe('VALIDATION_ERROR');
  });
});
