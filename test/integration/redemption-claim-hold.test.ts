import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { rateLimitRedis } from '../../src/redis/index.js';

interface ErrorResponseBody {
  error: { code: string; message: string };
}

interface RedemptionResponseBody {
  id: string;
  status: string;
  claim_state: string;
  claimable_at: string;
  seconds_until_claimable: number;
  can_claim_now: boolean;
  claimed_at: string | null;
  created_at: string;
}

interface RedemptionDetailResponseBody extends RedemptionResponseBody {
  timeline: { status: string; actor: string; note: string | null; at: string }[];
}

interface RedemptionListResponseBody {
  items: RedemptionResponseBody[];
  next_cursor: string | null;
}

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';
const HOLD_HOURS = 48;

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
      status: 'active',
      trust_level: 0,
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId, available_coin: 100_000 }).execute();
  // Backdated so the request clears the first-redemption-under-24h fraud rule and auto-approves.
  await db
    .updateTable('users')
    .set({ created_at: new Date(Date.now() - 48 * 60 * 60 * 1000) })
    .where('id', '=', userId)
    .execute();
  return userId;
}

async function createCatalogItem(): Promise<string> {
  const itemId = uuidv7();
  await db
    .insertInto('catalog_items')
    .values({
      id: itemId,
      sku: `sku-${randomUUID()}`,
      title: 'Test Gift Card',
      category: 'gift_card',
      face_value: '$1',
      usd_cost: '1.0000',
      coin_price: 1000,
      regions: ['VN'],
      is_active: true,
    })
    .execute();
  return itemId;
}

async function createAdminUser(role: string): Promise<string> {
  const adminId = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id: adminId, email: `admin-${randomUUID()}@test.local`, role })
    .execute();
  return adminId;
}

describe('redemption claim hold', () => {
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

  function userHeaders(userId: string): Record<string, string> {
    return { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` };
  }

  function adminHeaders(adminUserId: string): Record<string, string> {
    return {
      'x-admin-api-key': ADMIN_API_KEY,
      'x-admin-user-id': adminUserId,
      'x-csrf-token': ADMIN_CSRF_TOKEN,
    };
  }

  async function requestRedemption(userId: string): Promise<RedemptionResponseBody> {
    const itemId = await createCatalogItem();
    const res = await app.inject({
      method: 'POST',
      url: '/redemptions',
      headers: userHeaders(userId),
      payload: { catalog_item_id: itemId },
    });
    expect(res.statusCode).toBe(200);
    return res.json<RedemptionResponseBody>();
  }

  async function deliver(redemptionId: string): Promise<void> {
    const superadminId = await createAdminUser('superadmin');
    await app.inject({
      method: 'POST',
      url: `/admin/redemptions/${redemptionId}/fulfill`,
      headers: adminHeaders(superadminId),
      payload: {},
    });
    await app.inject({
      method: 'POST',
      url: `/admin/redemptions/${redemptionId}/paste-code`,
      headers: adminHeaders(superadminId),
      payload: { delivery_code: `CODE-${randomUUID()}` },
    });
  }

  async function elapseClaimHold(redemptionId: string): Promise<void> {
    await db
      .updateTable('redemptions')
      .set({ claimable_at: new Date(Date.now() - 60_000) })
      .where('id', '=', redemptionId)
      .execute();
  }

  it('starts the hold at request time, not at delivery', async () => {
    const userId = await createTestUser();
    const body = await requestRedemption(userId);

    const createdAt = new Date(body.created_at).getTime();
    const claimableAt = new Date(body.claimable_at).getTime();
    const holdMs = claimableAt - createdAt;
    // Allow a few seconds of slack: created_at is the DB clock, claimable_at the app clock.
    expect(holdMs).toBeGreaterThan(HOLD_HOURS * 60 * 60 * 1000 - 10_000);
    expect(holdMs).toBeLessThan(HOLD_HOURS * 60 * 60 * 1000 + 10_000);

    expect(body.claim_state).toBe('PENDING');
    expect(body.can_claim_now).toBe(false);
    expect(body.seconds_until_claimable).toBeGreaterThan(HOLD_HOURS * 60 * 60 - 60);
  });

  it('keeps the item PENDING after delivery while the hold is still running', async () => {
    const userId = await createTestUser();
    const { id: redemptionId } = await requestRedemption(userId);
    await deliver(redemptionId);

    const res = await app.inject({
      method: 'GET',
      url: `/redemptions/${redemptionId}`,
      headers: userHeaders(userId),
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json<RedemptionDetailResponseBody>();
    expect(detail.status).toBe('DELIVERED');
    expect(detail.claim_state).toBe('PENDING');
    expect(detail.can_claim_now).toBe(false);
    expect(detail.seconds_until_claimable).toBeGreaterThan(0);
  });

  it('blocks the delivery code with REDEMPTION_HOLD_ACTIVE before the hold elapses', async () => {
    const userId = await createTestUser();
    const { id: redemptionId } = await requestRedemption(userId);
    await deliver(redemptionId);
    await rateLimitRedis.del(`redemption-code:ratelimit:${userId}:${redemptionId}`);

    const res = await app.inject({
      method: 'GET',
      url: `/redemptions/${redemptionId}/code`,
      headers: userHeaders(userId),
    });
    expect(res.statusCode).toBe(409);
    const error = res.json<ErrorResponseBody & { error: { claimable_at?: string } }>().error;
    expect(error.code).toBe('REDEMPTION_HOLD_ACTIVE');
    // Carried in the body so the app can render a countdown without a second round trip to
    // GET /redemptions. Previously passed as AppError `details`, which is log-only and was dropped.
    expect(error.claimable_at).toBeTypeOf('string');
    expect(Date.parse(error.claimable_at ?? '')).toBeGreaterThan(Date.now());

    // The block must not have consumed the claim.
    const row = await db
      .selectFrom('redemptions')
      .select('claimed_at')
      .where('id', '=', redemptionId)
      .executeTakeFirstOrThrow();
    expect(row.claimed_at).toBeNull();
  });

  it('turns CLAIMABLE once the hold elapses and CLAIMED after the code is opened', async () => {
    const userId = await createTestUser();
    const { id: redemptionId } = await requestRedemption(userId);
    await deliver(redemptionId);
    await elapseClaimHold(redemptionId);
    await rateLimitRedis.del(`redemption-code:ratelimit:${userId}:${redemptionId}`);

    const claimable = await app.inject({
      method: 'GET',
      url: `/redemptions/${redemptionId}`,
      headers: userHeaders(userId),
    });
    expect(claimable.json<RedemptionDetailResponseBody>().claim_state).toBe('CLAIMABLE');
    expect(claimable.json<RedemptionDetailResponseBody>().can_claim_now).toBe(true);
    expect(claimable.json<RedemptionDetailResponseBody>().seconds_until_claimable).toBe(0);

    const code = await app.inject({
      method: 'GET',
      url: `/redemptions/${redemptionId}/code`,
      headers: userHeaders(userId),
    });
    expect(code.statusCode).toBe(200);

    const claimed = await app.inject({
      method: 'GET',
      url: `/redemptions/${redemptionId}`,
      headers: userHeaders(userId),
    });
    const claimedBody = claimed.json<RedemptionDetailResponseBody>();
    expect(claimedBody.claim_state).toBe('CLAIMED');
    expect(claimedBody.can_claim_now).toBe(false);
    expect(claimedBody.claimed_at).not.toBeNull();
  });

  it('returns the full status timeline on the detail endpoint', async () => {
    const userId = await createTestUser();
    const { id: redemptionId } = await requestRedemption(userId);
    await deliver(redemptionId);

    const res = await app.inject({
      method: 'GET',
      url: `/redemptions/${redemptionId}`,
      headers: userHeaders(userId),
    });
    const timeline = res.json<RedemptionDetailResponseBody>().timeline;
    expect(timeline.map((entry) => entry.status)).toEqual([
      'REQUESTED',
      'APPROVED',
      'PURCHASING',
      'DELIVERED',
    ]);
    expect(timeline[0]?.actor).toBe('user');
    expect(new Date(timeline[3]?.at ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(timeline[0]?.at ?? 0).getTime(),
    );
  });

  it('reports claim state on the list endpoint so the history screen needs no extra call', async () => {
    const userId = await createTestUser();
    const { id: redemptionId } = await requestRedemption(userId);

    const res = await app.inject({
      method: 'GET',
      url: '/redemptions',
      headers: userHeaders(userId),
    });
    expect(res.statusCode).toBe(200);
    const item = res.json<RedemptionListResponseBody>().items.find((e) => e.id === redemptionId);
    expect(item?.claim_state).toBe('PENDING');
    expect(item?.can_claim_now).toBe(false);
    expect(item?.seconds_until_claimable).toBeGreaterThan(0);
  });

  it('hides another user redemption behind a 404 on the detail endpoint', async () => {
    const ownerId = await createTestUser();
    const otherId = await createTestUser();
    const { id: redemptionId } = await requestRedemption(ownerId);

    const res = await app.inject({
      method: 'GET',
      url: `/redemptions/${redemptionId}`,
      headers: userHeaders(otherId),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorResponseBody>().error.code).toBe('REDEMPTION_NOT_FOUND');
  });

  it('applies the region claim_hold_hours set from the CMS', async () => {
    const regionId = `CH_${randomUUID().slice(0, 8)}`;
    const superadminId = await createAdminUser('superadmin');
    await db
      .insertInto('region_config')
      .values({
        region_id: regionId,
        countries: [],
        features: {
          timezone: 'UTC',
          redemption: {
            enabled: true,
            claim_hold_hours: 48,
            weekly_cap_usd: { '0': 5, '1': 5, '2': 15, '3': 50 },
          },
        },
      })
      .execute();

    try {
      const updated = await app.inject({
        method: 'PUT',
        url: `/admin/redemption/settings/${regionId}`,
        headers: adminHeaders(superadminId),
        payload: {
          enabled: true,
          weekly_cap_usd: { '0': 5, '1': 5, '2': 15, '3': 50 },
          claim_hold_hours: 1,
        },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json<{ claim_hold_hours: number }>().claim_hold_hours).toBe(1);

      const userId = await createTestUser();
      await db.updateTable('users').set({ region_id: regionId }).where('id', '=', userId).execute();
      try {
        const body = await requestRedemption(userId);
        const holdMs = new Date(body.claimable_at).getTime() - new Date(body.created_at).getTime();
        expect(holdMs).toBeLessThan(60 * 60 * 1000 + 10_000);
        expect(holdMs).toBeGreaterThan(60 * 60 * 1000 - 10_000);
      } finally {
        // users.region_id is a FK — the region cannot be dropped while this user still points at it.
        await db.updateTable('users').set({ region_id: 'VN' }).where('id', '=', userId).execute();
      }
    } finally {
      await db.deleteFrom('region_config').where('region_id', '=', regionId).execute();
    }
  });

  it('leaves claim_hold_hours untouched when the CMS omits it', async () => {
    const regionId = `CH_${randomUUID().slice(0, 8)}`;
    const superadminId = await createAdminUser('superadmin');
    await db
      .insertInto('region_config')
      .values({
        region_id: regionId,
        countries: [],
        features: {
          timezone: 'UTC',
          redemption: {
            enabled: true,
            claim_hold_hours: 12,
            weekly_cap_usd: { '0': 5, '1': 5, '2': 15, '3': 50 },
          },
        },
      })
      .execute();

    try {
      const updated = await app.inject({
        method: 'PUT',
        url: `/admin/redemption/settings/${regionId}`,
        headers: adminHeaders(superadminId),
        payload: { enabled: true, weekly_cap_usd: { '0': 5, '1': 10, '2': 15, '3': 50 } },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json<{ claim_hold_hours: number }>().claim_hold_hours).toBe(12);
    } finally {
      await db.deleteFrom('region_config').where('region_id', '=', regionId).execute();
    }
  });
});
