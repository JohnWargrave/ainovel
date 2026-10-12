import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import pino from 'pino';
import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { cacheRedis } from '../../src/redis/index.js';
import { getConfig } from '../../src/modules/config/config.service.js';
import { credit } from '../../src/modules/wallet-ledger/ledger.service.js';
import { processEconomyBackingAlertScan } from '../../src/jobs/economy-backing-alert.js';

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

interface ErrorResponseBody {
  error: { code: string; message: string };
}

interface RegionConfigBody {
  region_id: string;
  countries: string[];
  features: Record<string, unknown>;
  updated_at: string;
}

interface EconomyAnalyticsBody {
  from: string;
  to: string;
  region: string | null;
  coin_minted_by_source: Record<string, string>;
  coin_burned_by_sink: Record<string, string>;
  coin_minted_total: string;
  coin_burned_total: string;
  unbacked_coin: string;
  unbacked_pct: number;
  coin_redeemed_usd_cost: number;
  revenue_usd: number;
  clawback_rate_by_network: Record<string, number>;
  backing_ratio_today: number | null;
  mint_paused: boolean;
}

const BASE_FEATURES = {
  timezone: 'UTC',
  checkin: { enabled: true, rewards: [10, 15, 20] },
  tasks: {
    enabled: true,
    list: [
      {
        id: 'share_app',
        title: 'Share',
        description: 'Share it',
        reward_coin: 50,
        task_type: 'share_app',
      },
    ],
  },
};

async function createRegion(features: Record<string, unknown> = BASE_FEATURES): Promise<string> {
  const regionId = `R_${randomUUID().slice(0, 8)}`;
  await db
    .insertInto('region_config')
    .values({ region_id: regionId, countries: [], features })
    .execute();
  return regionId;
}

async function createUser(regionId: string): Promise<string> {
  const userId = uuidv7();
  await db
    .insertInto('users')
    .values({
      id: userId,
      auth_provider: 'guest',
      auth_subject: `region-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: regionId,
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId, available_coin: 0 }).execute();
  return userId;
}

async function createAdminUser(role: string): Promise<string> {
  const adminId = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id: adminId, email: `admin-${randomUUID()}@test.local`, role })
    .execute();
  return adminId;
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('admin region config, economy analytics and safety valve', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;
  let superadminId: string;
  let analystId: string;
  let reviewerId: string;
  let fulfillmentId: string;

  beforeAll(async () => {
    app = await buildApp();
    accessJwt = (app.jwt as unknown as { access: JWT }).access;
    superadminId = await createAdminUser('superadmin');
    analystId = await createAdminUser('analyst');
    reviewerId = await createAdminUser('reviewer');
    fulfillmentId = await createAdminUser('fulfillment');
  });

  afterAll(async () => {
    await app.close();
  });

  function auth(userId: string): Record<string, string> {
    return {
      ...APP_HEADERS,
      authorization: `Bearer ${accessJwt.sign({ sub: userId, trust_level: 0 })}`,
    };
  }

  function adminHeaders(adminUserId: string): Record<string, string> {
    return {
      'x-admin-api-key': ADMIN_API_KEY,
      'x-admin-user-id': adminUserId,
      'x-csrf-token': ADMIN_CSRF_TOKEN,
    };
  }

  it('returns the raw stored features and refuses non-superadmin readers', async () => {
    const regionId = await createRegion();

    const res = await app.inject({
      method: 'GET',
      url: `/admin/region-config/${regionId}`,
      headers: adminHeaders(superadminId),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<RegionConfigBody>();
    // Raw jsonb, not the filtered projection GET /config serves — `timezone` never appears there.
    expect(body.features['timezone']).toBe('UTC');

    const list = await app.inject({
      method: 'GET',
      url: '/admin/region-config',
      headers: adminHeaders(superadminId),
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json<{ items: { region_id: string }[] }>().items.some((r) => r.region_id === regionId),
    ).toBe(true);

    const asReviewer = await app.inject({
      method: 'GET',
      url: `/admin/region-config/${regionId}`,
      headers: adminHeaders(reviewerId),
    });
    expect(asReviewer.statusCode).toBe(403);
  });

  it('applies a feature change immediately instead of after the cache TTL', async () => {
    const regionId = await createRegion();
    // Warm the 60s Redis cache with the pre-change payload.
    const before = await getConfig(regionId);
    expect(before.payload.features.checkin['enabled']).toBe(true);

    const put = await app.inject({
      method: 'PUT',
      url: `/admin/region-config/${regionId}`,
      headers: adminHeaders(superadminId),
      payload: { features: { ...BASE_FEATURES, checkin: { enabled: false, rewards: [10] } } },
    });
    expect(put.statusCode).toBe(200);

    const after = await getConfig(regionId);
    expect(after.payload.features.checkin['enabled']).toBe(false);

    const audit = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'REGION_CONFIG_UPDATED')
      .where(sql<string>`detail->>'region'`, '=', regionId)
      .executeTakeFirstOrThrow();
    expect(audit.admin_user_id).toBe(superadminId);
    const detail = audit.detail as { before: { features: Record<string, unknown> } };
    expect((detail.before.features['checkin'] as { enabled: boolean }).enabled).toBe(true);
  });

  it('refuses to create regions and refuses malformed features', async () => {
    const missing = await app.inject({
      method: 'PUT',
      url: '/admin/region-config/NOPE',
      headers: adminHeaders(superadminId),
      payload: { features: {} },
    });
    expect(missing.statusCode).toBe(404);

    const regionId = await createRegion();
    const badFeatures = await app.inject({
      method: 'PUT',
      url: `/admin/region-config/${regionId}`,
      headers: adminHeaders(superadminId),
      payload: { features: ['not', 'an', 'object'] },
    });
    expect(badFeatures.statusCode).toBe(400);
    expect(badFeatures.json<ErrorResponseBody>().error.code).toBe('INVALID_FEATURES');

    const noCsrf = await app.inject({
      method: 'PUT',
      url: `/admin/region-config/${regionId}`,
      headers: { 'x-admin-api-key': ADMIN_API_KEY, 'x-admin-user-id': superadminId },
      payload: { features: {} },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('pauses unbacked minting without touching backed credits', async () => {
    const regionId = await createRegion();
    const userId = await createUser(regionId);

    const pause = await app.inject({
      method: 'PUT',
      url: `/admin/region-config/${regionId}`,
      headers: adminHeaders(superadminId),
      payload: { features: { ...BASE_FEATURES, economy: { mint_paused: true } } },
    });
    expect(pause.statusCode).toBe(200);

    const claim = await app.inject({
      method: 'POST',
      url: '/checkin/claim',
      headers: auth(userId),
    });
    expect(claim.statusCode).toBe(429);
    expect(claim.json<ErrorResponseBody>().error.code).toBe('MINT_PAUSED');

    // Backed coin is paid for by network revenue that has already been earned — rejecting it would
    // make the network retry forever, so the switch must not touch it.
    const backed = await credit({
      userId,
      entryType: 'OFFERWALL_CREDIT',
      amount: 100,
      revenueUsd: 0.5,
    });
    expect(backed.deduped).toBe(false);

    const unpause = await app.inject({
      method: 'PUT',
      url: `/admin/region-config/${regionId}`,
      headers: adminHeaders(superadminId),
      payload: { features: BASE_FEATURES },
    });
    expect(unpause.statusCode).toBe(200);

    const retry = await app.inject({
      method: 'POST',
      url: '/checkin/claim',
      headers: auth(userId),
    });
    expect(retry.statusCode).toBe(200);
  });

  it('reports minted, burned and unbacked coin for a region', async () => {
    const regionId = await createRegion();
    const userId = await createUser(regionId);

    await credit({ userId, entryType: 'WELCOME_CREDIT', amount: 100 });
    await credit({ userId, entryType: 'CHECKIN_CREDIT', amount: 40 });
    await credit({ userId, entryType: 'OFFERWALL_CREDIT', amount: 360, revenueUsd: 0.36 });
    await db
      .insertInto('coin_ledger')
      .values({
        id: uuidv7(),
        user_id: userId,
        entry_type: 'REDEMPTION_DEBIT',
        amount: -200,
        bucket: 'available',
        balance_after: 300,
      })
      .execute();

    const res = await app.inject({
      method: 'GET',
      url: `/admin/analytics/economy?region=${regionId}`,
      headers: adminHeaders(analystId),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<EconomyAnalyticsBody>();
    expect(body.coin_minted_by_source).toEqual({
      WELCOME_CREDIT: '100',
      CHECKIN_CREDIT: '40',
      OFFERWALL_CREDIT: '360',
    });
    expect(body.coin_burned_by_sink).toEqual({ REDEMPTION_DEBIT: '200' });
    expect(body.coin_minted_total).toBe('500');
    expect(body.coin_burned_total).toBe('200');
    // WELCOME_CREDIT + CHECKIN_CREDIT are the unbacked ones: 140 of 500.
    expect(body.unbacked_coin).toBe('140');
    expect(body.unbacked_pct).toBeCloseTo(0.28, 5);
    expect(body.mint_paused).toBe(false);

    // Redis day counters were incremented by credit(): 500 coin minted, $0.36 revenue.
    expect(body.backing_ratio_today).not.toBeNull();

    const fulfillmentRead = await app.inject({
      method: 'GET',
      url: `/admin/analytics/economy?region=${regionId}`,
      headers: adminHeaders(fulfillmentId),
    });
    expect(fulfillmentRead.statusCode).toBe(403);
  });

  it('excludes ledger rows outside the requested window', async () => {
    const regionId = await createRegion();
    const userId = await createUser(regionId);

    await db
      .insertInto('coin_ledger')
      .values([
        {
          id: uuidv7(),
          user_id: userId,
          entry_type: 'WELCOME_CREDIT',
          amount: 70,
          bucket: 'available',
          balance_after: 70,
          created_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
        },
        {
          id: uuidv7(),
          user_id: userId,
          entry_type: 'CHECKIN_CREDIT',
          amount: 30,
          bucket: 'available',
          balance_after: 100,
        },
      ])
      .execute();

    const recent = await app.inject({
      method: 'GET',
      url: `/admin/analytics/economy?region=${regionId}`,
      headers: adminHeaders(analystId),
    });
    // Default window is the last 30 days, so the backdated row is out.
    expect(recent.json<EconomyAnalyticsBody>().coin_minted_total).toBe('30');

    const wide = await app.inject({
      method: 'GET',
      url: `/admin/analytics/economy?region=${regionId}&from=2000-01-01`,
      headers: adminHeaders(analystId),
    });
    expect(wide.json<EconomyAnalyticsBody>().coin_minted_total).toBe('100');

    const badRange = await app.inject({
      method: 'GET',
      url: '/admin/analytics/economy?from=not-a-date',
      headers: adminHeaders(analystId),
    });
    expect(badRange.statusCode).toBe(400);
    expect(badRange.json<ErrorResponseBody>().error.code).toBe('INVALID_RANGE');
  });

  it('computes revenue, redemption cost and clawback rate per network', async () => {
    const regionId = await createRegion();
    const userId = await createUser(regionId);

    await db
      .insertInto('earning_events')
      .values([
        {
          id: uuidv7(),
          user_id: userId,
          source: 'adgate',
          payout_usd: '0.5000',
          coin_awarded: 100,
          status: 'credited',
          raw_payload: JSON.stringify({}),
        },
        {
          id: uuidv7(),
          user_id: userId,
          source: 'adgate',
          payout_usd: '0.5000',
          coin_awarded: 100,
          status: 'credited',
          raw_payload: JSON.stringify({}),
        },
        {
          id: uuidv7(),
          user_id: userId,
          source: 'adgate',
          payout_usd: '0.5000',
          coin_awarded: 100,
          status: 'clawed_back',
          raw_payload: JSON.stringify({}),
        },
        {
          id: uuidv7(),
          user_id: userId,
          source: 'tapjoy',
          payout_usd: '0.2000',
          coin_awarded: 40,
          status: 'credited',
          raw_payload: JSON.stringify({}),
        },
      ])
      .execute();

    const itemId = uuidv7();
    await db
      .insertInto('catalog_items')
      .values({
        id: itemId,
        sku: `sku-${randomUUID()}`,
        title: 'Gift Card',
        category: 'gift_card',
        face_value: '$1',
        usd_cost: '1.0000',
        coin_price: 1000,
        regions: ['VN'],
        is_active: true,
      })
      .execute();
    await db
      .insertInto('redemptions')
      .values([
        {
          id: uuidv7(),
          user_id: userId,
          catalog_item_id: itemId,
          coin_price: 1000,
          usd_cost_est: '1.0000',
          reward_snapshot: {
            sku: 'analytics-gift-card',
            title: 'Gift Card',
            category: 'gift_card',
            face_value: '$1',
            image_url: null,
          },
          status: 'DELIVERED',
        },
        {
          id: uuidv7(),
          user_id: userId,
          catalog_item_id: itemId,
          coin_price: 1000,
          usd_cost_est: '1.0000',
          reward_snapshot: {
            sku: 'analytics-gift-card',
            title: 'Gift Card',
            category: 'gift_card',
            face_value: '$1',
            image_url: null,
          },
          // Not delivered yet — no real cost incurred, so it must not appear in the total.
          status: 'FRAUD_REVIEW',
        },
      ])
      .execute();

    const res = await app.inject({
      method: 'GET',
      url: `/admin/analytics/economy?region=${regionId}`,
      headers: adminHeaders(analystId),
    });
    const body = res.json<EconomyAnalyticsBody>();
    // Clawed-back events are not revenue: 0.5 + 0.5 + 0.2.
    expect(body.revenue_usd).toBeCloseTo(1.2, 5);
    expect(body.coin_redeemed_usd_cost).toBeCloseTo(1, 5);
    expect(body.clawback_rate_by_network['adgate']).toBeCloseTo(1 / 3, 5);
    expect(body.clawback_rate_by_network['tapjoy']).toBe(0);
  });

  it('alerts once per region per day when the backing ratio falls below the threshold', async () => {
    const regionId = await createRegion();
    const logger = pino({ level: 'silent' });

    // 10 000 coin = $1 minted at COIN_PER_USD 10 000, backed by $0.50 → ratio 0.5.
    await cacheRedis.set(`econ:minted:${regionId}:${dayKey()}`, '10000');
    await cacheRedis.set(`econ:revenue_micro_usd:${regionId}:${dayKey()}`, '500000');

    await processEconomyBackingAlertScan(logger);
    await processEconomyBackingAlertScan(logger);

    const alerts = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'ECONOMY_BACKING_LOW')
      .where(sql<string>`detail->>'region'`, '=', regionId)
      .execute();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.detail).toMatchObject({ region: regionId, threshold: 1.2 });

    // A healthy region and a region that minted nothing today both stay silent.
    const healthy = await createRegion();
    // $1 minted backed by $2 → ratio 2.0, comfortably above the 1.2 threshold.
    await cacheRedis.set(`econ:minted:${healthy}:${dayKey()}`, '10000');
    await cacheRedis.set(`econ:revenue_micro_usd:${healthy}:${dayKey()}`, '2000000');
    const idle = await createRegion();

    await processEconomyBackingAlertScan(logger);

    const quiet = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'ECONOMY_BACKING_LOW')
      .where(sql<string>`detail->>'region'`, 'in', [healthy, idle])
      .execute();
    expect(quiet).toHaveLength(0);
  });
});
