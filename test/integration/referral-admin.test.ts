import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { assignReferralCode } from '../../src/modules/referral/referral-code.js';
import { credit, debit } from '../../src/modules/wallet-ledger/ledger.service.js';

const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

interface ReferralSettingsBody {
  region_id: string;
  enabled: boolean;
  reward_pct: number;
  duration_months: number | null;
  milestone_bonus_coin: number;
  milestone_bonus_threshold: number;
  hold_hours: number;
  credit_immediately: boolean;
  updated_at: string;
}

interface ReferralSummaryBody {
  user_id: string;
  referral_code: string | null;
  total_referrals: number;
  qualified_referrals: number;
  pending_referrals: number;
  total_earned_coin: string;
  available_earned_coin: string;
  pending_earned_coin: string;
  clawed_back_coin: string;
  referral_frozen: boolean;
}

interface ReferralDetailBody {
  summary: ReferralSummaryBody;
  user: { id: string; referral_code: string | null };
  referrer: { id: string } | null;
  referred_users: { id: string; referral_qualified_at: string | null }[];
  recent_earnings: {
    amount: string;
    state: 'available' | 'pending' | 'frozen' | 'clawed_back';
    hold_until: string | null;
  }[];
}

async function createRegion(): Promise<string> {
  const regionId = `RA_${randomUUID().slice(0, 8)}`;
  await db
    .insertInto('region_config')
    .values({
      region_id: regionId,
      countries: [],
      features: {
        timezone: 'UTC',
        referral: {
          enabled: true,
          pct: 0.1,
          duration_months: null,
          milestone_bonus_coin: 2_000,
          milestone_bonus_threshold: 50_000,
          hold_hours: 0,
          credit_immediately: false,
        },
      },
    })
    .execute();
  return regionId;
}

async function createUser(
  regionId: string,
  referredBy?: string,
  qualified = false,
): Promise<{ id: string; code: string }> {
  const id = uuidv7();
  const code = await db.transaction().execute((trx) => assignReferralCode(trx));
  await db
    .insertInto('users')
    .values({
      id,
      auth_provider: 'guest',
      auth_subject: `referral-admin-${randomUUID()}`,
      email: `${id}@test.local`,
      country_code: 'VN',
      region_id: regionId,
      referral_code: code,
      referred_by: referredBy ?? null,
      referred_by_set_at: referredBy ? new Date() : null,
      referral_qualified_at: qualified ? new Date() : null,
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: id }).execute();
  return { id, code };
}

async function createAdmin(role: string): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id, email: `${role}-${randomUUID()}@test.local`, role })
    .execute();
  return id;
}

describe('referral CMS API', () => {
  let app: FastifyInstance;
  let superadminId: string;
  let reviewerId: string;
  let analystId: string;
  let fulfillmentId: string;

  beforeAll(async () => {
    app = await buildApp();
    superadminId = await createAdmin('superadmin');
    reviewerId = await createAdmin('reviewer');
    analystId = await createAdmin('analyst');
    fulfillmentId = await createAdmin('fulfillment');
  });

  afterAll(async () => {
    await app.close();
  });

  function headers(adminId: string): Record<string, string> {
    return {
      'x-admin-api-key': ADMIN_API_KEY,
      'x-admin-user-id': adminId,
      'x-csrf-token': ADMIN_CSRF_TOKEN,
    };
  }

  it('allows referral readers and restricts configuration writes to superadmins', async () => {
    const regionId = await createRegion();
    const read = await app.inject({
      method: 'GET',
      url: '/admin/referrals/settings',
      headers: headers(analystId),
    });
    expect(read.statusCode).toBe(200);
    expect(
      read
        .json<{ items: ReferralSettingsBody[] }>()
        .items.find((item) => item.region_id === regionId)?.hold_hours,
    ).toBe(0);

    const forbidden = await app.inject({
      method: 'PUT',
      url: `/admin/referrals/settings/${regionId}`,
      headers: headers(reviewerId),
      payload: {
        enabled: true,
        reward_pct: 0.15,
        duration_months: 12,
        milestone_bonus_coin: 3_000,
        milestone_bonus_threshold: 60_000,
        hold_hours: 24,
        credit_immediately: true,
      },
    });
    expect(forbidden.statusCode).toBe(403);

    const update = await app.inject({
      method: 'PUT',
      url: `/admin/referrals/settings/${regionId}`,
      headers: headers(superadminId),
      payload: {
        enabled: true,
        reward_pct: 0.15,
        duration_months: 12,
        milestone_bonus_coin: 3_000,
        milestone_bonus_threshold: 60_000,
        hold_hours: 24,
        credit_immediately: true,
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json<ReferralSettingsBody>()).toMatchObject({
      region_id: regionId,
      reward_pct: 0.15,
      duration_months: 12,
      hold_hours: 24,
      credit_immediately: true,
    });

    const stored = await db
      .selectFrom('region_config')
      .select('features')
      .where('region_id', '=', regionId)
      .executeTakeFirstOrThrow();
    expect((stored.features as { timezone: string }).timezone).toBe('UTC');
    const audit = await db
      .selectFrom('audit_log')
      .select(['admin_user_id', 'detail'])
      .where('action', '=', 'REFERRAL_SETTINGS_UPDATED')
      .where('admin_user_id', '=', superadminId)
      .executeTakeFirstOrThrow();
    expect((audit.detail as { region_id: string }).region_id).toBe(regionId);
  });

  it('lists attribution and separates available, pending, and clawed-back referral coin', async () => {
    const regionId = await createRegion();
    const referrer = await createUser(regionId);
    const qualified = await createUser(regionId, referrer.id, true);
    const pending = await createUser(regionId, referrer.id, false);
    await credit({
      userId: referrer.id,
      entryType: 'REFERRAL_CREDIT',
      amount: 100,
      refType: 'earning_event',
      refId: uuidv7(),
    });
    await credit({
      userId: referrer.id,
      entryType: 'REFERRAL_CREDIT',
      amount: 50,
      bucket: 'pending',
      holdUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      refType: 'earning_event',
      refId: uuidv7(),
    });
    await debit({
      userId: referrer.id,
      entryType: 'REFERRAL_CLAWBACK',
      amount: 20,
      refType: 'earning_event',
      refId: uuidv7(),
    });

    const list = await app.inject({
      method: 'GET',
      url: `/admin/referrals?q=${encodeURIComponent(referrer.code)}`,
      headers: headers(reviewerId),
    });
    expect(list.statusCode, list.body).toBe(200);
    const summary = list.json<{ items: ReferralSummaryBody[] }>().items[0];
    expect(summary).toMatchObject({
      user_id: referrer.id,
      total_referrals: 2,
      qualified_referrals: 1,
      pending_referrals: 1,
      total_earned_coin: '130',
      available_earned_coin: '80',
      pending_earned_coin: '50',
      clawed_back_coin: '20',
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/admin/referrals/${referrer.id}`,
      headers: headers(analystId),
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json<ReferralDetailBody>();
    expect(body.referrer).toBeNull();
    expect(body.referred_users.map((user) => user.id)).toEqual(
      expect.arrayContaining([qualified.id, pending.id]),
    );
    expect(body.recent_earnings).toHaveLength(3);

    const wrongRole = await app.inject({
      method: 'GET',
      url: '/admin/referrals',
      headers: headers(fulfillmentId),
    });
    expect(wrongRole.statusCode).toBe(403);
  });

  it('updates and regenerates unique codes with an audit trail', async () => {
    const regionId = await createRegion();
    const user = await createUser(regionId);
    const other = await createUser(regionId);

    const duplicate = await app.inject({
      method: 'PUT',
      url: `/admin/referrals/${user.id}/code`,
      headers: headers(superadminId),
      payload: { code: other.code, reason: 'duplicate check' },
    });
    expect(duplicate.statusCode).toBe(409);

    const replacement = 'HP-ABC234';
    const update = await app.inject({
      method: 'PUT',
      url: `/admin/referrals/${user.id}/code`,
      headers: headers(superadminId),
      payload: { code: replacement, reason: 'support correction' },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json<ReferralDetailBody>().user.referral_code).toBe(replacement);

    const regenerate = await app.inject({
      method: 'POST',
      url: `/admin/referrals/${user.id}/code/regenerate`,
      headers: headers(superadminId),
      payload: { reason: 'code exposed publicly' },
    });
    expect(regenerate.statusCode).toBe(200);
    expect(regenerate.json<ReferralDetailBody>().user.referral_code).toMatch(
      /^HP-[A-HJ-NP-Z2-9]{6}$/,
    );
    expect(regenerate.json<ReferralDetailBody>().user.referral_code).not.toBe(replacement);

    const actions = await db
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', user.id)
      .where('action', 'in', ['REFERRAL_CODE_UPDATED', 'REFERRAL_CODE_REGENERATED'])
      .execute();
    expect(actions.map((row) => row.action).sort()).toEqual([
      'REFERRAL_CODE_REGENERATED',
      'REFERRAL_CODE_UPDATED',
    ]);
  });

  it('clears reviewed freezes without releasing before the configured wait', async () => {
    const regionId = await createRegion();
    const user = await createUser(regionId);
    await db
      .updateTable('region_config')
      .set({
        features: {
          referral: {
            enabled: true,
            pct: 0.1,
            duration_months: null,
            milestone_bonus_coin: 0,
            milestone_bonus_threshold: 50_000,
            hold_hours: 24,
          },
        },
      })
      .where('region_id', '=', regionId)
      .execute();
    await db
      .insertInto('fraud_flags')
      .values({
        id: uuidv7(),
        user_id: user.id,
        rule_code: 'RF02',
        severity: 3,
        evidence: {},
        status: 'open',
      })
      .execute();
    const createdAt = new Date();
    await credit({
      userId: user.id,
      entryType: 'REFERRAL_CREDIT',
      amount: 75,
      bucket: 'pending',
      holdUntil: new Date('2099-01-01T00:00:00Z'),
      refType: 'referral_milestone',
      refId: uuidv7(),
    });

    const frozen = await app.inject({
      method: 'GET',
      url: `/admin/referrals/${user.id}`,
      headers: headers(reviewerId),
    });
    expect(frozen.json<ReferralDetailBody>().summary.referral_frozen).toBe(true);

    const clear = await app.inject({
      method: 'POST',
      url: `/admin/referrals/${user.id}/clear-freeze`,
      headers: headers(reviewerId),
      payload: { reason: 'reviewed as carrier NAT' },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json<ReferralDetailBody>().summary.referral_frozen).toBe(false);

    const entry = await db
      .selectFrom('coin_ledger')
      .select('hold_until')
      .where('user_id', '=', user.id)
      .where('entry_type', '=', 'REFERRAL_CREDIT')
      .executeTakeFirstOrThrow();
    expect(entry.hold_until?.getTime()).toBeGreaterThanOrEqual(
      createdAt.getTime() + 24 * 60 * 60 * 1000,
    );
    expect(entry.hold_until?.getUTCFullYear()).not.toBe(2099);
    const flag = await db
      .selectFrom('fraud_flags')
      .select('status')
      .where('user_id', '=', user.id)
      .where('rule_code', '=', 'RF02')
      .executeTakeFirstOrThrow();
    expect(flag.status).toBe('dismissed');
  });
});
