import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';

const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

interface SettingsBody {
  welcome_coin: number;
  google_login: number;
  updated_at: string;
}

interface LoginOffersBody {
  items: {
    auth_provider: 'password' | 'google';
    welcome_coin: number;
    provider_bonus_coin: number;
    total_coin: number;
  }[];
  updated_at: string;
}

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

async function createAdminUser(role: string): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id, email: `reward-${randomUUID()}@test.local`, role })
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

describe('coin reward settings admin API', () => {
  let app: FastifyInstance;
  let superadminId: string;
  let analystId: string;

  beforeAll(async () => {
    app = await buildApp();
    superadminId = await createAdminUser('superadmin');
    analystId = await createAdminUser('analyst');
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns and updates settings for a superadmin with an audit record', async () => {
    const get = await app.inject({
      method: 'GET',
      url: '/admin/coin-reward-settings',
      headers: adminHeaders(superadminId),
    });
    expect(get.statusCode).toBe(200);
    const before = get.json<SettingsBody>();
    expect(before.welcome_coin).toBe(10_000);
    expect(before.google_login).toBe(2_000);

    const put = await app.inject({
      method: 'PUT',
      url: '/admin/coin-reward-settings',
      headers: adminHeaders(superadminId),
      // Same values back, so suites signing up guests in parallel are unaffected.
      payload: {
        welcome_coin: before.welcome_coin,
        google_login: before.google_login,
        welcome_mode: 'instant',
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<SettingsBody>()).toMatchObject({
      welcome_coin: 10_000,
      google_login: 2_000,
      welcome_mode: 'instant',
    });

    const audit = await db
      .selectFrom('audit_log')
      .select(['admin_user_id', 'detail'])
      .where('action', '=', 'COIN_REWARD_SETTINGS_UPDATED')
      .where('admin_user_id', '=', superadminId)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({
      before: { welcome_coin: 10_000, google_login: 2_000, welcome_mode: 'instant' },
      after: { welcome_coin: 10_000, google_login: 2_000, welcome_mode: 'instant' },
    });
  });

  it('lists the effective password and Google login offers for the app', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/login-offers',
      headers: APP_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<LoginOffersBody>().items).toEqual([
      {
        auth_provider: 'password',
        welcome_coin: 10_000,
        provider_bonus_coin: 0,
        total_coin: 10_000,
      },
      {
        auth_provider: 'google',
        welcome_coin: 10_000,
        provider_bonus_coin: 2_000,
        total_coin: 12_000,
      },
    ]);
    expect(response.json<{ welcome_mode: string }>().welcome_mode).toBe('instant');

    const versioned = await app.inject({
      method: 'GET',
      url: '/v1/auth/login-offers',
      headers: APP_HEADERS,
    });
    expect(versioned.statusCode).toBe(200);
    expect(versioned.json<LoginOffersBody>().items).toEqual(response.json<LoginOffersBody>().items);
  });

  it('requires the superadmin role, CSRF, and bounded integer values', async () => {
    const analystRead = await app.inject({
      method: 'GET',
      url: '/admin/coin-reward-settings',
      headers: adminHeaders(analystId),
    });
    expect(analystRead.statusCode).toBe(403);

    const noCsrf = await app.inject({
      method: 'PUT',
      url: '/admin/coin-reward-settings',
      headers: adminHeaders(superadminId, false),
      payload: { welcome_coin: 10_000, google_login: 2_000 },
    });
    expect(noCsrf.statusCode).toBe(403);

    const invalid = await app.inject({
      method: 'PUT',
      url: '/admin/coin-reward-settings',
      headers: adminHeaders(superadminId),
      payload: { welcome_coin: -1, google_login: 2_000 },
    });
    expect(invalid.statusCode).toBe(400);

    const badMode = await app.inject({
      method: 'PUT',
      url: '/admin/coin-reward-settings',
      headers: adminHeaders(superadminId),
      payload: { welcome_coin: 10_000, google_login: 2_000, welcome_mode: 'later' },
    });
    expect(badMode.statusCode).toBe(400);
  });
});
