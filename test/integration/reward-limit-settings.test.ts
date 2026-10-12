import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import type { JWT } from '@fastify/jwt';
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

interface RewardedAdsRegionSettings {
  region_id: string;
  enabled: boolean;
  daily_cap: number;
  cooldown_s: number;
  timezone: string;
  updated_at: string;
}

interface SpinConfigAdmin {
  id: string;
  name: string;
  ticket_coin: string;
  daily_cap: number;
  is_active: boolean;
  used_by: { region_id: string; role: 'paid' | 'free' }[];
  updated_at: string;
}

interface SpinStateBody {
  daily_cap: number;
  spins_today: number;
  spins_remaining: number;
  free_spin_available: boolean;
}

async function createAdminUser(role: string): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id, email: `limits-${randomUUID()}@test.local`, role })
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

describe('reward limit settings admin API', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;
  let superadminId: string;
  let analystId: string;

  async function createSpinUser(regionId: string): Promise<string> {
    const userId = uuidv7();
    await db
      .insertInto('users')
      .values({
        id: userId,
        auth_provider: 'guest',
        auth_subject: `limits-${randomUUID()}`,
        email: null,
        country_code: 'VN',
        region_id: regionId,
        status: 'active',
      })
      .execute();
    await db.insertInto('wallets').values({ user_id: userId }).execute();
    return userId;
  }

  async function spinState(userId: string): Promise<SpinStateBody> {
    const res = await app.inject({
      method: 'GET',
      url: '/spin/state',
      headers: {
        ...APP_HEADERS,
        authorization: `Bearer ${accessJwt.sign({ sub: userId, trust_level: 0 })}`,
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json<SpinStateBody>();
  }

  beforeAll(async () => {
    app = await buildApp();
    accessJwt = (app.jwt as unknown as { access: JWT }).access;
    superadminId = await createAdminUser('superadmin');
    analystId = await createAdminUser('analyst');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('rewarded ads', () => {
    async function createRegion(): Promise<string> {
      const regionId = `RL_${randomUUID().slice(0, 8)}`;
      await db
        .insertInto('region_config')
        .values({
          region_id: regionId,
          countries: [],
          features: {
            timezone: 'Asia/Ho_Chi_Minh',
            checkin: { enabled: true, rewards: [10, 15] },
            rewarded_ads: {
              enabled: false,
              daily_cap: 20,
              coin_cap: 50,
              cooldown_s: 30,
              est_ecpm_usd: 2.5,
            },
          },
        })
        .execute();
      return regionId;
    }

    function settingsFor(
      items: RewardedAdsRegionSettings[],
      regionId: string,
    ): RewardedAdsRegionSettings {
      const found = items.find((item) => item.region_id === regionId);
      if (!found) throw new Error(`Region ${regionId} missing from settings list`);
      return found;
    }

    it('lists the current cap and cooldown per region for a superadmin', async () => {
      const regionId = await createRegion();
      const res = await app.inject({
        method: 'GET',
        url: '/admin/rewarded-ads/settings',
        headers: adminHeaders(superadminId),
      });
      expect(res.statusCode).toBe(200);
      expect(
        settingsFor(res.json<{ items: RewardedAdsRegionSettings[] }>().items, regionId),
      ).toMatchObject({
        region_id: regionId,
        enabled: false,
        daily_cap: 20,
        cooldown_s: 30,
        timezone: 'Asia/Ho_Chi_Minh',
      });
    });

    it('updates only the rewarded_ads feature and leaves the rest of the region intact', async () => {
      const regionId = await createRegion();
      const res = await app.inject({
        method: 'PUT',
        url: `/admin/rewarded-ads/settings/${regionId}`,
        headers: adminHeaders(superadminId),
        payload: { enabled: true, daily_cap: 8, cooldown_s: 45 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<RewardedAdsRegionSettings>()).toMatchObject({
        region_id: regionId,
        enabled: true,
        daily_cap: 8,
        cooldown_s: 45,
      });

      const row = await db
        .selectFrom('region_config')
        .select('features')
        .where('region_id', '=', regionId)
        .executeTakeFirstOrThrow();
      const features = row.features as {
        timezone: string;
        checkin: { enabled: boolean; rewards: number[] };
        rewarded_ads: Record<string, unknown>;
      };
      expect(features.timezone).toBe('Asia/Ho_Chi_Minh');
      expect(features.checkin).toEqual({ enabled: true, rewards: [10, 15] });
      // Economy inputs the form does not expose must survive the write.
      expect(features.rewarded_ads).toMatchObject({
        enabled: true,
        daily_cap: 8,
        cooldown_s: 45,
        coin_cap: 50,
        est_ecpm_usd: 2.5,
      });

      const audit = await db
        .selectFrom('audit_log')
        .select(['admin_user_id', 'detail'])
        .where('action', '=', 'REWARDED_ADS_SETTINGS_UPDATED')
        .where('admin_user_id', '=', superadminId)
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();
      expect(audit.detail).toMatchObject({
        region_id: regionId,
        before: { daily_cap: 20, cooldown_s: 30, enabled: false },
        after: { daily_cap: 8, cooldown_s: 45, enabled: true },
      });
    });

    // getConfig rather than GET /config: the route picks its region by geoip on the caller IP, which
    // a synthetic test region can never be resolved to. The cache is the part at risk here, and
    // getConfig is what reads and writes it.
    it('serves the new cap from the region config payload immediately after a save', async () => {
      const regionId = await createRegion();
      const before = await getConfig(regionId);
      expect(before.payload.features.rewarded_ads['daily_cap']).toBe(20);

      const put = await app.inject({
        method: 'PUT',
        url: `/admin/rewarded-ads/settings/${regionId}`,
        headers: adminHeaders(superadminId),
        payload: { enabled: true, daily_cap: 3, cooldown_s: 15 },
      });
      expect(put.statusCode).toBe(200);

      const after = await getConfig(regionId);
      expect(after.payload.features.rewarded_ads).toMatchObject({
        enabled: true,
        daily_cap: 3,
        cooldown_s: 15,
      });
      expect(after.etag).not.toBe(before.etag);
    });

    it('requires superadmin, CSRF, a known region, and in-range integers', async () => {
      const regionId = await createRegion();

      const analystRead = await app.inject({
        method: 'GET',
        url: '/admin/rewarded-ads/settings',
        headers: adminHeaders(analystId),
      });
      expect(analystRead.statusCode).toBe(403);

      const noCsrf = await app.inject({
        method: 'PUT',
        url: `/admin/rewarded-ads/settings/${regionId}`,
        headers: adminHeaders(superadminId, false),
        payload: { enabled: true, daily_cap: 5, cooldown_s: 30 },
      });
      expect(noCsrf.statusCode).toBe(403);

      for (const payload of [
        { enabled: true, daily_cap: 0, cooldown_s: 30 },
        { enabled: true, daily_cap: 1001, cooldown_s: 30 },
        { enabled: true, daily_cap: 5, cooldown_s: -1 },
        { enabled: true, daily_cap: 1.5, cooldown_s: 30 },
      ]) {
        const invalid = await app.inject({
          method: 'PUT',
          url: `/admin/rewarded-ads/settings/${regionId}`,
          headers: adminHeaders(superadminId),
          payload,
        });
        expect(invalid.statusCode).toBe(400);
      }

      const missing = await app.inject({
        method: 'PUT',
        url: '/admin/rewarded-ads/settings/NOPE',
        headers: adminHeaders(superadminId),
        payload: { enabled: true, daily_cap: 5, cooldown_s: 30 },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json<ErrorResponseBody>().error.code).toBe('CONFIG_NOT_FOUND');
    });
  });

  describe('spin configs', () => {
    // prizeCoin sets the table's expected value, which spin.service.ts range-checks per mode: a paid
    // table must not exceed max_ev_coin (50 by default), a free table sits between 30 and 50.
    async function createSpinConfig(dailyCap: number, prizeCoin = 20): Promise<string> {
      const id = randomUUID();
      await db
        .insertInto('spin_config')
        .values({
          id,
          name: `limits-${id.slice(0, 8)}`,
          ticket_coin: '100',
          daily_cap: dailyCap,
          prizes: JSON.stringify([
            { slot: 1, type: 'coin', value: prizeCoin, weight: 1, tier: 'low' },
          ]),
        })
        .execute();
      return id;
    }

    function configFor(items: SpinConfigAdmin[], configId: string): SpinConfigAdmin {
      const found = items.find((item) => item.id === configId);
      if (!found) throw new Error(`Spin config ${configId} missing from list`);
      return found;
    }

    it('lists every table with the regions that point at it', async () => {
      const paidId = await createSpinConfig(20);
      const freeId = await createSpinConfig(1);
      const regionId = `SL_${randomUUID().slice(0, 8)}`;
      await db
        .insertInto('region_config')
        .values({
          region_id: regionId,
          countries: [],
          features: {
            timezone: 'UTC',
            spin: { enabled: true, table_id: paidId, free_table_id: freeId },
          },
        })
        .execute();

      const res = await app.inject({
        method: 'GET',
        url: '/admin/spin/configs',
        headers: adminHeaders(superadminId),
      });
      expect(res.statusCode).toBe(200);
      const items = res.json<{ items: SpinConfigAdmin[] }>().items;
      expect(configFor(items, paidId)).toMatchObject({
        daily_cap: 20,
        ticket_coin: '100',
        is_active: true,
        used_by: [{ region_id: regionId, role: 'paid' }],
      });
      expect(configFor(items, freeId).used_by).toEqual([{ region_id: regionId, role: 'free' }]);
    });

    it('updates the paid daily cap with an audit record', async () => {
      const configId = await createSpinConfig(20);
      const res = await app.inject({
        method: 'PUT',
        url: `/admin/spin/configs/${configId}`,
        headers: adminHeaders(superadminId),
        payload: { daily_cap: 6 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<SpinConfigAdmin>()).toMatchObject({ id: configId, daily_cap: 6 });

      const stored = await db
        .selectFrom('spin_config')
        .select(['daily_cap', 'ticket_coin'])
        .where('id', '=', configId)
        .executeTakeFirstOrThrow();
      expect(stored.daily_cap).toBe(6);
      expect(stored.ticket_coin).toBe('100');

      const audit = await db
        .selectFrom('audit_log')
        .select(['detail', 'target_id'])
        .where('action', '=', 'SPIN_CONFIG_UPDATED')
        .where('target_id', '=', configId)
        .orderBy('id', 'desc')
        .executeTakeFirstOrThrow();
      expect(audit.detail).toMatchObject({ before: { daily_cap: 20 }, after: { daily_cap: 6 } });
    });

    it('serves the new paid cap from the region config payload and on /spin/state', async () => {
      const paidId = await createSpinConfig(20);
      const freeId = await createSpinConfig(1, 40);
      const regionId = `SC_${randomUUID().slice(0, 8)}`;
      await db
        .insertInto('region_config')
        .values({
          region_id: regionId,
          countries: [],
          features: {
            timezone: 'UTC',
            spin: { enabled: true, table_id: paidId, free_table_id: freeId },
          },
        })
        .execute();
      const userId = await createSpinUser(regionId);

      expect((await getConfig(regionId)).payload.features.spin['daily_cap']).toBe(20);
      expect((await spinState(userId)).daily_cap).toBe(20);

      const put = await app.inject({
        method: 'PUT',
        url: `/admin/spin/configs/${paidId}`,
        headers: adminHeaders(superadminId),
        payload: { daily_cap: 4 },
      });
      expect(put.statusCode).toBe(200);

      expect((await getConfig(regionId)).payload.features.spin['daily_cap']).toBe(4);
      const state = await spinState(userId);
      expect(state.daily_cap).toBe(4);
      expect(state.spins_remaining).toBe(4);
      // The free spin is a separate lane and must not be taxed by the paid cap.
      expect(state.free_spin_available).toBe(true);
    });

    it('requires superadmin, CSRF, a known table, and a positive bounded cap', async () => {
      const configId = await createSpinConfig(20);

      const analystRead = await app.inject({
        method: 'GET',
        url: '/admin/spin/configs',
        headers: adminHeaders(analystId),
      });
      expect(analystRead.statusCode).toBe(403);

      const noCsrf = await app.inject({
        method: 'PUT',
        url: `/admin/spin/configs/${configId}`,
        headers: adminHeaders(superadminId, false),
        payload: { daily_cap: 5 },
      });
      expect(noCsrf.statusCode).toBe(403);

      for (const daily_cap of [0, 1001, 2.5]) {
        const invalid = await app.inject({
          method: 'PUT',
          url: `/admin/spin/configs/${configId}`,
          headers: adminHeaders(superadminId),
          payload: { daily_cap },
        });
        expect(invalid.statusCode).toBe(400);
      }

      const missing = await app.inject({
        method: 'PUT',
        url: `/admin/spin/configs/${randomUUID()}`,
        headers: adminHeaders(superadminId),
        payload: { daily_cap: 5 },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json<ErrorResponseBody>().error.code).toBe('SPIN_CONFIG_NOT_FOUND');
    });
  });
});
