import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';

const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

interface ErrorResponseBody {
  error: { code: string; message: string };
}

interface GrantBody {
  amount_coin: number;
  new_balance: string;
  deduped: boolean;
}

interface StateBody {
  enabled: boolean;
  max_amount_coin: number;
}

async function createUser(status = 'active'): Promise<string> {
  const userId = uuidv7();
  await db
    .insertInto('users')
    .values({
      id: userId,
      auth_provider: 'guest',
      auth_subject: `direct-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: 'VN',
      status,
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId, available_coin: 0 }).execute();
  return userId;
}

async function createAdminUser(role: string): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id, email: `direct-${randomUUID()}@test.local`, role })
    .execute();
  return id;
}

function adminHeaders(id: string, csrf = true): Record<string, string> {
  return {
    'x-admin-api-key': ADMIN_API_KEY,
    'x-admin-user-id': id,
    ...(csrf ? { 'x-csrf-token': ADMIN_CSRF_TOKEN } : {}),
  };
}

async function setSettings(enabled: boolean, maxAmountCoin = 1000): Promise<void> {
  await db
    .updateTable('direct_coin_settings')
    .set({ enabled, max_amount_coin: maxAmountCoin, updated_at: new Date() })
    .where('id', '=', 'global')
    .execute();
}

async function balanceOf(userId: string): Promise<string> {
  const wallet = await db
    .selectFrom('wallets')
    .select('available_coin')
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  return wallet.available_coin;
}

describe('direct coin credit', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;
  let superadminId: string;
  let analystId: string;

  beforeAll(async () => {
    app = await buildApp();
    accessJwt = (app.jwt as unknown as { access: JWT }).access;
    superadminId = await createAdminUser('superadmin');
    analystId = await createAdminUser('analyst');
  });

  afterEach(async () => {
    await setSettings(false, 1000);
  });

  afterAll(async () => {
    await app.close();
  });

  function authHeaders(userId: string): Record<string, string> {
    const token = accessJwt.sign({ sub: userId, trust_level: 0 });
    return { ...APP_HEADERS, authorization: `Bearer ${token}` };
  }

  it('credits the amount the client asked for when the feature is enabled', async () => {
    await setSettings(true, 1000);
    const userId = await createUser();

    const res = await app.inject({
      method: 'POST',
      url: '/earning/coin',
      headers: authHeaders(userId),
      payload: { amount_coin: 250 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<GrantBody>();
    expect(body.amount_coin).toBe(250);
    expect(body.new_balance).toBe('250');
    expect(body.deduped).toBe(false);
    expect(await balanceOf(userId)).toBe('250');

    const ledger = await db
      .selectFrom('coin_ledger')
      .select(['entry_type', 'amount'])
      .where('user_id', '=', userId)
      .execute();
    expect(ledger).toEqual([{ entry_type: 'DIRECT_CREDIT', amount: '250' }]);
  });

  it('refuses to credit while the feature is off', async () => {
    await setSettings(false);
    const userId = await createUser();

    const res = await app.inject({
      method: 'POST',
      url: '/earning/coin',
      headers: authHeaders(userId),
      payload: { amount_coin: 100 },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorResponseBody>().error.code).toBe('FEATURE_DISABLED');
    expect(await balanceOf(userId)).toBe('0');
  });

  it('rejects an amount above the CMS per-request ceiling', async () => {
    await setSettings(true, 500);
    const userId = await createUser();

    const res = await app.inject({
      method: 'POST',
      url: '/earning/coin',
      headers: authHeaders(userId),
      payload: { amount_coin: 501 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorResponseBody>().error.code).toBe('AMOUNT_TOO_LARGE');
    expect(await balanceOf(userId)).toBe('0');
  });

  it('credits once for a repeated idempotency key', async () => {
    await setSettings(true, 1000);
    const userId = await createUser();
    const payload = { amount_coin: 100, idempotency_key: `key-${randomUUID()}` };

    const first = await app.inject({
      method: 'POST',
      url: '/earning/coin',
      headers: authHeaders(userId),
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/earning/coin',
      headers: authHeaders(userId),
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json<GrantBody>().deduped).toBe(false);
    expect(second.json<GrantBody>().deduped).toBe(true);
    expect(second.json<GrantBody>().amount_coin).toBe(0);
    expect(await balanceOf(userId)).toBe('100');
  });

  it('does not let one user dedupe against another user key', async () => {
    await setSettings(true, 1000);
    const key = `shared-${randomUUID()}`;
    const userA = await createUser();
    const userB = await createUser();

    for (const userId of [userA, userB]) {
      const res = await app.inject({
        method: 'POST',
        url: '/earning/coin',
        headers: authHeaders(userId),
        payload: { amount_coin: 100, idempotency_key: key },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<GrantBody>().deduped).toBe(false);
    }

    expect(await balanceOf(userA)).toBe('100');
    expect(await balanceOf(userB)).toBe('100');
  });

  it('refuses a banned account', async () => {
    await setSettings(true, 1000);
    const userId = await createUser('banned');

    const res = await app.inject({
      method: 'POST',
      url: '/earning/coin',
      headers: authHeaders(userId),
      payload: { amount_coin: 100 },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorResponseBody>().error.code).toBe('EARNING_BLOCKED');
    expect(await balanceOf(userId)).toBe('0');
  });

  // The per-request ceiling bounds one call; this is what bounds the sum of them. Without it the
  // feature is an unlimited mint for anyone willing to loop.
  it('stops at the I2 rolling unbacked cap', async () => {
    await setSettings(true, 10_000);
    const userId = await createUser();

    const first = await app.inject({
      method: 'POST',
      url: '/earning/coin',
      headers: authHeaders(userId),
      payload: { amount_coin: 10_000 },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/earning/coin',
      headers: authHeaders(userId),
      payload: { amount_coin: 10_000 },
    });
    const third = await app.inject({
      method: 'POST',
      url: '/earning/coin',
      headers: authHeaders(userId),
      payload: { amount_coin: 1 },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json<ErrorResponseBody>().error.code).toBe('UNBACKED_CAP_EXCEEDED');
    expect(await balanceOf(userId)).toBe('20000');
  });

  it('reports the switch to the app so it can hide the entry point', async () => {
    const userId = await createUser();

    await setSettings(false, 750);
    const off = await app.inject({
      method: 'GET',
      url: '/earning/coin/state',
      headers: authHeaders(userId),
    });
    expect(off.json<StateBody>()).toEqual({ enabled: false, max_amount_coin: 750 });

    await setSettings(true, 750);
    const on = await app.inject({
      method: 'GET',
      url: '/earning/coin/state',
      headers: authHeaders(userId),
    });
    expect(on.json<StateBody>()).toEqual({ enabled: true, max_amount_coin: 750 });
  });

  it('lets a superadmin flip the switch and audits it, but refuses an analyst', async () => {
    const denied = await app.inject({
      method: 'PUT',
      url: '/admin/direct-coin-settings',
      headers: adminHeaders(analystId),
      payload: { enabled: true, max_amount_coin: 1000 },
    });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({
      method: 'PUT',
      url: '/admin/direct-coin-settings',
      headers: adminHeaders(superadminId),
      payload: { enabled: true, max_amount_coin: 2500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<StateBody>()).toMatchObject({ enabled: true, max_amount_coin: 2500 });

    const audit = await db
      .selectFrom('audit_log')
      .select(['action', 'detail'])
      .where('action', '=', 'DIRECT_COIN_SETTINGS_UPDATED')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({
      after: { enabled: true, max_amount_coin: 2500 },
    });
  });
});
