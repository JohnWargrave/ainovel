import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { cacheRedis } from '../../src/redis/index.js';

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

interface ConfigResponseBody {
  region: string;
  welcome: { mode: string; coin: number };
  features: {
    spin: { enabled: boolean; ticket_coin: number; daily_cap: number; odds_disclosure: string };
    offerwall: { enabled: boolean; networks: string[]; share_pct: number };
    rewarded_ads: { enabled: boolean; daily_cap: number; cooldown_s: number };
    redemption: { enabled: boolean };
    checkin: { enabled: boolean; rewards: number[] };
  };
  coin_per_usd: number;
  min_supported_app_version: string;
}

async function createAdminUser(role: string): Promise<string> {
  const adminId = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id: adminId, email: `admin-${randomUUID()}@test.local`, role })
    .execute();
  return adminId;
}

async function createTestUser(): Promise<string> {
  const userId = uuidv7();
  await db
    .insertInto('users')
    .values({
      id: userId,
      auth_provider: 'guest',
      auth_subject: `test-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: 'VN',
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId }).execute();
  return userId;
}

describe('API contract baseline config', () => {
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

  it('returns server-driven config with Redis cache and ETag', async () => {
    await cacheRedis.del('config:v1:ROW');

    const res = await app.inject({ method: 'GET', url: '/config', headers: APP_HEADERS });
    expect(res.statusCode).toBe(200);
    const body = res.json<ConfigResponseBody>();
    expect(body.region).toBe('ROW');
    expect(body.coin_per_usd).toBe(10000);
    expect(body.min_supported_app_version).toBe('1.0.0');
    expect(body.welcome).toEqual({ mode: 'instant', coin: 10_000 });
    expect(body.features.offerwall.enabled).toBe(true);
    expect(body.features.offerwall.networks).toContain('tapjoy');
    expect(body.features.offerwall.share_pct).toBe(30);
    expect(body.features.rewarded_ads.enabled).toBe(true);
    expect(body.features.rewarded_ads.daily_cap).toBe(20);
    expect(body.features.rewarded_ads.cooldown_s).toBe(30);
    expect(body.features.spin.enabled).toBe(true);
    // Spins are funded by a rewarded ad now. The field is retained at 0 rather than removed so
    // clients that read it keep parsing.
    expect(body.features.spin.ticket_coin).toBe(0);
    expect(body.features.spin.daily_cap).toBe(20);
    expect(body.features.spin.odds_disclosure).toBeTypeOf('string');
    expect(body.features.spin).not.toHaveProperty('spins_today');
    expect(body.features.spin).not.toHaveProperty('free_spin_available');
    expect(body.features.redemption.enabled).toBe(true);
    expect(body.features.checkin.enabled).toBe(true);
    expect(body.features.checkin.rewards.length).toBeGreaterThan(0);
    expect(body.features.checkin).not.toHaveProperty('streak_day');
    expect(body.features.checkin).not.toHaveProperty('today_claimed');

    const etag = res.headers.etag;
    expect(etag).toBeTypeOf('string');
    const cached = await cacheRedis.get('config:v1:ROW');
    expect(cached).not.toBeNull();

    const cachedRes = await app.inject({
      method: 'GET',
      url: '/config',
      headers: { ...APP_HEADERS, 'if-none-match': String(etag) },
    });
    expect(cachedRes.statusCode).toBe(304);
    expect(cachedRes.body).toBe('');
  });

  it('requires app headers for app-originated config requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/config' });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorResponseBody>().error.code).toBe('VALIDATION_ERROR');
  });

  it('invalidates config cache through a CSRF-protected superadmin admin mutation', async () => {
    await app.inject({ method: 'GET', url: '/config', headers: APP_HEADERS });
    expect(await cacheRedis.get('config:v1:ROW')).not.toBeNull();

    const superadminId = await createAdminUser('superadmin');
    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/admin/config/invalidate-cache',
      headers: { 'x-admin-api-key': ADMIN_API_KEY, 'x-admin-user-id': superadminId },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json<ErrorResponseBody>().error.code).toBe('CSRF_TOKEN_INVALID');

    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/invalidate-cache',
      headers: {
        'x-admin-api-key': ADMIN_API_KEY,
        'x-admin-user-id': superadminId,
        'x-csrf-token': ADMIN_CSRF_TOKEN,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(await cacheRedis.get('config:v1:ROW')).toBeNull();

    const audit = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('admin_user_id', '=', superadminId)
      .where('action', '=', 'CONFIG_CACHE_INVALIDATED')
      .execute();
    expect(audit).toHaveLength(1);
  });

  it('exposes /v1 aliases for config, wallet, redemptions, and admin list', async () => {
    const configRes = await app.inject({ method: 'GET', url: '/v1/config', headers: APP_HEADERS });
    expect(configRes.statusCode).toBe(200);

    const userId = await createTestUser();
    const token = tokenFor(userId);
    const walletRes = await app.inject({
      method: 'GET',
      url: '/v1/wallet',
      headers: { ...APP_HEADERS, authorization: `Bearer ${token}` },
    });
    expect(walletRes.statusCode).toBe(200);

    const redemptionsRes = await app.inject({
      method: 'GET',
      url: '/v1/redemptions',
      headers: { ...APP_HEADERS, authorization: `Bearer ${token}` },
    });
    expect(redemptionsRes.statusCode).toBe(200);

    const reviewerId = await createAdminUser('reviewer');
    const adminListRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/redemptions',
      headers: { 'x-admin-api-key': ADMIN_API_KEY, 'x-admin-user-id': reviewerId },
    });
    expect(adminListRes.statusCode).toBe(200);
  });
});
