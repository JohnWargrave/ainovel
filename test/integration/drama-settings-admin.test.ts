import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { getConfig } from '../../src/modules/config/config.service.js';

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

interface DramaRegionSettings {
  region_id: string;
  enabled: boolean;
  episode_reward_coin: number;
  completion_ratio: number;
  episode_reward_daily_cap: number;
  timezone: string;
  updated_at: string;
}

interface HeartbeatBody {
  watched_seconds: number;
  required_seconds: number;
  rewarded: boolean;
  credited_coin: number;
  new_balance: string;
}

async function createAdminUser(role: string): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id, email: `drama-cms-${randomUUID()}@test.local`, role })
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

describe('drama settings admin API', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;
  let superadminId: string;
  let analystId: string;

  // Mirrors what migration 14 seeds: the module is off and pays nothing until an operator turns it
  // on, which is exactly the state this endpoint exists to change.
  async function createRegion(): Promise<string> {
    const regionId = `DS_${randomUUID().slice(0, 6)}`;
    await db
      .insertInto('region_config')
      .values({
        region_id: regionId,
        countries: [],
        features: {
          timezone: 'Asia/Ho_Chi_Minh',
          checkin: { enabled: true, rewards: [10, 15] },
          drama: {
            enabled: false,
            catalog_region: 'VN',
            interstitial_every: 2,
            episode_reward_daily_cap: 20,
          },
        },
      })
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
        auth_subject: `drama-cms-${randomUUID()}`,
        email: null,
        country_code: 'VN',
        region_id: regionId,
        status: 'active',
      })
      .execute();
    await db.insertInto('wallets').values({ user_id: userId, available_coin: 0 }).execute();
    return userId;
  }

  function settingsFor(items: DramaRegionSettings[], regionId: string): DramaRegionSettings {
    const found = items.find((item) => item.region_id === regionId);
    if (!found) throw new Error(`Region ${regionId} missing from settings list`);
    return found;
  }

  beforeAll(async () => {
    app = await buildApp();
    accessJwt = (app.jwt as unknown as { access: JWT }).access;
    superadminId = await createAdminUser('superadmin');
    analystId = await createAdminUser('analyst');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists the effective reward settings per region, defaults included', async () => {
    const regionId = await createRegion();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/drama/settings',
      headers: adminHeaders(superadminId),
    });
    expect(res.statusCode).toBe(200);
    // episode_reward_coin is absent from the stored object, so the list has to show the 0 the
    // heartbeat actually reads rather than a blank field.
    expect(settingsFor(res.json<{ items: DramaRegionSettings[] }>().items, regionId)).toMatchObject(
      {
        region_id: regionId,
        enabled: false,
        episode_reward_coin: 0,
        completion_ratio: 0.8,
        episode_reward_daily_cap: 20,
        timezone: 'Asia/Ho_Chi_Minh',
      },
    );
  });

  it('updates only the drama feature and leaves the rest of the region intact', async () => {
    const regionId = await createRegion();
    const res = await app.inject({
      method: 'PUT',
      url: `/admin/drama/settings/${regionId}`,
      headers: adminHeaders(superadminId),
      payload: {
        enabled: true,
        episode_reward_coin: 12,
        completion_ratio: 0.8,
        episode_reward_daily_cap: 20,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<DramaRegionSettings>()).toMatchObject({
      region_id: regionId,
      enabled: true,
      episode_reward_coin: 12,
    });

    const row = await db
      .selectFrom('region_config')
      .select('features')
      .where('region_id', '=', regionId)
      .executeTakeFirstOrThrow();
    const features = row.features as {
      timezone: string;
      checkin: { enabled: boolean; rewards: number[] };
      drama: Record<string, unknown>;
    };
    expect(features.timezone).toBe('Asia/Ho_Chi_Minh');
    expect(features.checkin).toEqual({ enabled: true, rewards: [10, 15] });
    // App-facing keys the form does not expose must survive the write.
    expect(features.drama).toMatchObject({
      enabled: true,
      episode_reward_coin: 12,
      catalog_region: 'VN',
      interstitial_every: 2,
    });

    const audit = await db
      .selectFrom('audit_log')
      .select(['admin_user_id', 'detail'])
      .where('action', '=', 'DRAMA_SETTINGS_UPDATED')
      .where('admin_user_id', '=', superadminId)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({
      region_id: regionId,
      before: { enabled: false, episode_reward_coin: 0 },
      after: { enabled: true, episode_reward_coin: 12 },
    });
  });

  // The whole point of the endpoint: a region left at the seeded default never pays, and turning it
  // on from the CMS is what makes the heartbeat credit.
  it('turns a silent heartbeat into a paying one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-19T10:00:00Z'));
    const regionId = await createRegion();
    const userId = await createUser(regionId);

    async function beat(elapsed: number): Promise<HeartbeatBody> {
      const res = await app.inject({
        method: 'POST',
        url: '/drama/watch-heartbeat',
        headers: {
          ...APP_HEADERS,
          authorization: `Bearer ${accessJwt.sign({ sub: userId, trust_level: 0 })}`,
        },
        payload: {
          drama_id: 'series-cms',
          episode_index: 0,
          elapsed_seconds: elapsed,
          duration_seconds: 90,
        },
      });
      expect(res.statusCode).toBe(200);
      return res.json<HeartbeatBody>();
    }

    await beat(0);
    vi.setSystemTime(new Date('2026-08-19T10:01:16Z')); // 76s of real, forward playback
    const disabled = await beat(76);
    expect(disabled).toMatchObject({
      watched_seconds: 76,
      required_seconds: 72,
      rewarded: false,
      credited_coin: 0,
      // Not null even when nothing is credited: the field reports the wallet, not the reward.
      new_balance: '0',
    });

    const put = await app.inject({
      method: 'PUT',
      url: `/admin/drama/settings/${regionId}`,
      headers: adminHeaders(superadminId),
      payload: {
        enabled: true,
        episode_reward_coin: 12,
        completion_ratio: 0.8,
        episode_reward_daily_cap: 20,
      },
    });
    expect(put.statusCode).toBe(200);

    vi.setSystemTime(new Date('2026-08-19T10:01:20Z'));
    const enabled = await beat(80);
    expect(enabled).toMatchObject({ rewarded: true, credited_coin: 12, new_balance: '12' });

    // The beat after the paying one: rewarded goes back to false, but the balance stays visible.
    // This is the pair that used to read as "the reward never worked" from the client's side.
    vi.setSystemTime(new Date('2026-08-19T10:01:24Z'));
    const afterReward = await beat(84);
    expect(afterReward).toMatchObject({
      rewarded: false,
      credited_coin: 0,
      new_balance: '12',
    });
  });

  it('serves the new reward from the config payload immediately after a save', async () => {
    const regionId = await createRegion();
    const before = await getConfig(regionId);
    expect(before.payload.features.drama['enabled']).toBe(false);

    const put = await app.inject({
      method: 'PUT',
      url: `/admin/drama/settings/${regionId}`,
      headers: adminHeaders(superadminId),
      payload: {
        enabled: true,
        episode_reward_coin: 25,
        completion_ratio: 0.5,
        episode_reward_daily_cap: 5,
      },
    });
    expect(put.statusCode).toBe(200);

    const after = await getConfig(regionId);
    expect(after.payload.features.drama).toMatchObject({
      enabled: true,
      episode_reward_coin: 25,
      completion_ratio: 0.5,
      episode_reward_daily_cap: 5,
    });
    expect(after.etag).not.toBe(before.etag);
  });

  it('requires superadmin, CSRF, a known region, and in-range values', async () => {
    const regionId = await createRegion();
    const valid = {
      enabled: true,
      episode_reward_coin: 12,
      completion_ratio: 0.8,
      episode_reward_daily_cap: 20,
    };

    const analystRead = await app.inject({
      method: 'GET',
      url: '/admin/drama/settings',
      headers: adminHeaders(analystId),
    });
    expect(analystRead.statusCode).toBe(403);

    const noCsrf = await app.inject({
      method: 'PUT',
      url: `/admin/drama/settings/${regionId}`,
      headers: adminHeaders(superadminId, false),
      payload: valid,
    });
    expect(noCsrf.statusCode).toBe(403);

    // Each of these is a value parseDramaFeature would silently replace with a default, which would
    // leave the CMS showing something the heartbeat does not use.
    for (const payload of [
      { ...valid, episode_reward_coin: -1 },
      { ...valid, episode_reward_coin: 1.5 },
      { ...valid, episode_reward_coin: 1_000_001 },
      { ...valid, completion_ratio: 0.05 },
      { ...valid, completion_ratio: 1.2 },
      { ...valid, episode_reward_daily_cap: -1 },
      { ...valid, episode_reward_daily_cap: 10_001 },
    ]) {
      const invalid = await app.inject({
        method: 'PUT',
        url: `/admin/drama/settings/${regionId}`,
        headers: adminHeaders(superadminId),
        payload,
      });
      expect(invalid.statusCode).toBe(400);
    }

    const missing = await app.inject({
      method: 'PUT',
      url: '/admin/drama/settings/NOPE',
      headers: adminHeaders(superadminId),
      payload: valid,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ErrorResponseBody>().error.code).toBe('CONFIG_NOT_FOUND');
  });
});
