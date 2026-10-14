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
  reward: {
    sku: string;
    title: string;
    category: string;
    face_value: string;
    image_url: string | null;
  };
  fraud_score_at_request: number | null;
  reject_reason: string | null;
  delivery_note: string | null;
  claimed_at: string | null;
}

interface RedemptionListResponseBody {
  items: RedemptionResponseBody[];
  next_cursor: string | null;
}

interface DeliveryCodeResponseBody {
  redemption_id: string;
  delivery_code: string;
  delivery_note: string | null;
}

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

async function createTestUser(overrides?: {
  status?: string;
  trust_level?: number;
  created_at?: Date;
}): Promise<string> {
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
      status: overrides?.status ?? 'active',
      trust_level: overrides?.trust_level ?? 0,
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId, available_coin: 100_000 }).execute();
  if (overrides?.created_at) {
    await db
      .updateTable('users')
      .set({ created_at: overrides.created_at })
      .where('id', '=', userId)
      .execute();
  }
  return userId;
}

async function createCatalogItem(overrides?: {
  usd_cost?: string;
  coin_price?: number;
  regions?: string[];
  is_active?: boolean;
  recipient_type?: 'none' | 'paypal_email';
}): Promise<string> {
  const itemId = uuidv7();
  await db
    .insertInto('catalog_items')
    .values({
      id: itemId,
      sku: `sku-${randomUUID()}`,
      title: 'Test Gift Card',
      category: 'gift_card',
      face_value: '$1',
      usd_cost: overrides?.usd_cost ?? '1.0000',
      coin_price: overrides?.coin_price ?? 1000,
      regions: overrides?.regions ?? ['VN'],
      is_active: overrides?.is_active ?? true,
      recipient_type: overrides?.recipient_type ?? 'none',
    })
    .execute();
  return itemId;
}

// Pushes the claim hold into the past so a test can exercise the post-hold path without waiting.
async function elapseClaimHold(redemptionId: string): Promise<void> {
  await db
    .updateTable('redemptions')
    .set({ claimable_at: new Date(Date.now() - 60_000) })
    .where('id', '=', redemptionId)
    .execute();
}

async function createAdminUser(role: string): Promise<string> {
  const adminId = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id: adminId, email: `admin-${randomUUID()}@test.local`, role })
    .execute();
  return adminId;
}

describe('redemption core', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;

  beforeAll(async () => {
    app = await buildApp();
    accessJwt = (app.jwt as unknown as { access: JWT }).access;
  });

  afterAll(async () => {
    await app.close();
  });

  function tokenFor(userId: string, trustLevel = 0): string {
    return accessJwt.sign({ sub: userId, trust_level: trustLevel });
  }

  function adminHeaders(adminUserId: string): Record<string, string> {
    return {
      'x-admin-api-key': ADMIN_API_KEY,
      'x-admin-user-id': adminUserId,
      'x-csrf-token': ADMIN_CSRF_TOKEN,
    };
  }

  describe('POST /redemptions', () => {
    it('creates a redemption and auto-approves a low-risk request', async () => {
      const userId = await createTestUser({
        created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });

      const res = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<RedemptionResponseBody>();
      expect(body.status).toBe('APPROVED');
      expect(body.reward).toMatchObject({
        title: 'Test Gift Card',
        category: 'gift_card',
        face_value: '$1',
      });
      expect(body.claimed_at).toBeNull();

      const wallet = await db
        .selectFrom('wallets')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(wallet.available_coin).toBe('99000');
      expect(wallet.lifetime_redeemed).toBe('1000');

      const ledgerRows = await db
        .selectFrom('coin_ledger')
        .selectAll()
        .where('user_id', '=', userId)
        .where('entry_type', '=', 'REDEMPTION_DEBIT')
        .execute();
      expect(ledgerRows).toHaveLength(1);

      const history = await db
        .selectFrom('redemption_status_history')
        .selectAll()
        .where('redemption_id', '=', body.id)
        .orderBy('created_at', 'asc')
        .execute();
      expect(history.map((h) => h.to_status)).toEqual(['REQUESTED', 'APPROVED']);

      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('target_id', '=', body.id)
        .execute();
      expect(audit.length).toBeGreaterThan(0);
    });

    it('keeps an immutable reward receipt when the catalog item changes later', async () => {
      const userId = await createTestUser({
        created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });
      const created = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      expect(created.statusCode).toBe(200);

      await db
        .updateTable('catalog_items')
        .set({ title: 'Renamed Gift Card', face_value: '$99' })
        .where('id', '=', itemId)
        .execute();

      const listed = await app.inject({
        method: 'GET',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json<RedemptionListResponseBody>().items[0]?.reward).toMatchObject({
        title: 'Test Gift Card',
        face_value: '$1',
      });
    });

    it('rejects an inactive catalog item', async () => {
      const userId = await createTestUser();
      const itemId = await createCatalogItem({ is_active: false });

      const res = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorResponseBody>().error.code).toBe('CATALOG_ITEM_UNAVAILABLE');
    });

    it('rejects a catalog item unavailable in the user region', async () => {
      const userId = await createTestUser();
      const itemId = await createCatalogItem({ regions: ['US'] });

      const res = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorResponseBody>().error.code).toBe('CATALOG_ITEM_UNAVAILABLE');
    });

    it('rejects redemption for a suspended user', async () => {
      const userId = await createTestUser({ status: 'suspended' });
      const itemId = await createCatalogItem();

      const res = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<ErrorResponseBody>().error.code).toBe('REDEMPTION_SUSPENDED');
    });

    it('rejects redemption for a banned user', async () => {
      const userId = await createTestUser({ status: 'banned' });
      const itemId = await createCatalogItem();

      const res = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<ErrorResponseBody>().error.code).toBe('REDEMPTION_BLOCKED');
    });

    it('rejects redemption when the user does not have enough available coin', async () => {
      const userId = await createTestUser();
      await db
        .updateTable('wallets')
        .set({ available_coin: 10 })
        .where('user_id', '=', userId)
        .execute();
      const itemId = await createCatalogItem({ coin_price: 1000 });

      const res = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorResponseBody>().error.code).toBe('INSUFFICIENT_BALANCE');
    });

    it('enforces the weekly redemption cap for the user trust level', async () => {
      // trust level 0 -> weekly cap $5 (the catalog minimum)
      const userId = await createTestUser({ trust_level: 0 });
      const firstItem = await createCatalogItem({ usd_cost: '4.5000', coin_price: 4500 });
      const first = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: firstItem },
      });
      expect(first.statusCode).toBe(200);

      const secondItem = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });
      const second = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: secondItem },
      });
      expect(second.statusCode).toBe(400);
      expect(second.json<ErrorResponseBody>().error.code).toBe('REDEMPTION_WEEKLY_CAP');
    });

    it('routes a first redemption under 24h to FRAUD_REVIEW (E02)', async () => {
      const userId = await createTestUser({ created_at: new Date() });
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });

      const res = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<RedemptionResponseBody>().status).toBe('FRAUD_REVIEW');

      const flags = await db
        .selectFrom('fraud_flags')
        .selectAll()
        .where('user_id', '=', userId)
        .where('rule_code', '=', 'E02')
        .execute();
      expect(flags).toHaveLength(1);
    });

    it('routes score >=70 (R01) to FRAUD_REVIEW', async () => {
      const userId = await createTestUser({
        created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });
      await db
        .insertInto('fraud_flags')
        .values({
          id: uuidv7(),
          user_id: userId,
          rule_code: 'MANUAL_TEST',
          severity: 8,
          evidence: null,
        })
        .execute();
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });

      const res = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<RedemptionResponseBody>().status).toBe('FRAUD_REVIEW');
    });

    it('routes score >=90 (R02) to REJECTED, suspends the user, and refunds', async () => {
      const userId = await createTestUser({
        created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });
      await db
        .insertInto('fraud_flags')
        .values({
          id: uuidv7(),
          user_id: userId,
          rule_code: 'MANUAL_TEST',
          severity: 10,
          evidence: null,
        })
        .execute();
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });

      const res = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<RedemptionResponseBody>();
      expect(body.status).toBe('REJECTED');

      const user = await db
        .selectFrom('users')
        .select('status')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(user.status).toBe('suspended');

      const wallet = await db
        .selectFrom('wallets')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(wallet.available_coin).toBe('100000');
      expect(wallet.lifetime_redeemed).toBe('0');

      const refunds = await db
        .selectFrom('coin_ledger')
        .selectAll()
        .where('user_id', '=', userId)
        .where('entry_type', '=', 'REDEMPTION_REFUND')
        .execute();
      expect(refunds).toHaveLength(1);
    });
  });

  describe('admin redemption settings', () => {
    it('validates and updates only the redemption feature for a region', async () => {
      const regionId = `RS_${randomUUID().slice(0, 8)}`;
      const superadminId = await createAdminUser('superadmin');
      const reviewerId = await createAdminUser('reviewer');
      await db
        .insertInto('region_config')
        .values({
          region_id: regionId,
          countries: [],
          features: {
            timezone: 'UTC',
            checkin: { enabled: true },
            redemption: {
              enabled: false,
              auto_approve_paused: true,
              weekly_cap_usd: { '0': 5, '1': 5, '2': 15, '3': 50 },
            },
          },
        })
        .execute();

      try {
        const forbidden = await app.inject({
          method: 'GET',
          url: '/admin/redemption/settings',
          headers: adminHeaders(reviewerId),
        });
        expect(forbidden.statusCode).toBe(403);

        const belowMinimum = await app.inject({
          method: 'PUT',
          url: `/admin/redemption/settings/${regionId}`,
          headers: adminHeaders(superadminId),
          payload: {
            enabled: true,
            weekly_cap_usd: { '0': 2, '1': 5, '2': 15, '3': 50 },
          },
        });
        expect(belowMinimum.statusCode).toBe(400);

        const decreasing = await app.inject({
          method: 'PUT',
          url: `/admin/redemption/settings/${regionId}`,
          headers: adminHeaders(superadminId),
          payload: {
            enabled: true,
            weekly_cap_usd: { '0': 10, '1': 5, '2': 15, '3': 50 },
          },
        });
        expect(decreasing.statusCode).toBe(400);
        expect(decreasing.json<ErrorResponseBody>().error.code).toBe('INVALID_REDEMPTION_CAPS');

        const updated = await app.inject({
          method: 'PUT',
          url: `/admin/redemption/settings/${regionId}`,
          headers: adminHeaders(superadminId),
          payload: {
            enabled: true,
            weekly_cap_usd: { '0': 5, '1': 10, '2': 25, '3': 50 },
          },
        });
        expect(updated.statusCode).toBe(200);
        expect(updated.json()).toMatchObject({
          region_id: regionId,
          enabled: true,
          weekly_cap_usd: { '0': 5, '1': 10, '2': 25, '3': 50 },
        });

        const listed = await app.inject({
          method: 'GET',
          url: '/admin/redemption/settings',
          headers: adminHeaders(superadminId),
        });
        expect(listed.statusCode).toBe(200);
        expect(listed.json<{ min_redemption_usd: number }>().min_redemption_usd).toBe(5);

        const stored = await db
          .selectFrom('region_config')
          .select('features')
          .where('region_id', '=', regionId)
          .executeTakeFirstOrThrow();
        expect(stored.features).toMatchObject({
          timezone: 'UTC',
          checkin: { enabled: true },
          redemption: { enabled: true, auto_approve_paused: true },
        });
        const audit = await db
          .selectFrom('audit_log')
          .select(['admin_user_id', 'detail'])
          .where('action', '=', 'REDEMPTION_SETTINGS_UPDATED')
          .where('admin_user_id', '=', superadminId)
          .executeTakeFirstOrThrow();
        expect((audit.detail as { region_id: string }).region_id).toBe(regionId);
      } finally {
        await db.deleteFrom('region_config').where('region_id', '=', regionId).execute();
      }
    });
  });

  describe('GET /redemptions', () => {
    it('lists only the requesting user redemptions', async () => {
      const userId = await createTestUser();
      const otherUserId = await createTestUser();
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });

      await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(otherUserId)}` },
        payload: { catalog_item_id: itemId },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<RedemptionListResponseBody>();
      expect(body.items).toHaveLength(1);
    });
  });

  describe('admin auth', () => {
    it('rejects a missing/bad shared secret', async () => {
      const adminId = await createAdminUser('superadmin');
      const res = await app.inject({
        method: 'GET',
        url: '/admin/redemptions',
        headers: { 'x-admin-api-key': 'wrong-key', 'x-admin-user-id': adminId },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a missing x-admin-user-id header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/redemptions',
        headers: { 'x-admin-api-key': ADMIN_API_KEY },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an unknown admin user id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/redemptions',
        headers: { 'x-admin-api-key': ADMIN_API_KEY, 'x-admin-user-id': uuidv7() },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects a role not permitted for the action', async () => {
      const analystId = await createAdminUser('analyst');
      const res = await app.inject({
        method: 'GET',
        url: '/admin/redemptions',
        headers: adminHeaders(analystId),
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects an admin mutation without a CSRF token', async () => {
      const userId = await createTestUser({ created_at: new Date() });
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });
      const created = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      const redemptionId = created.json<RedemptionResponseBody>().id;

      const reviewerAdmin = await createAdminUser('reviewer');
      const res = await app.inject({
        method: 'POST',
        url: `/admin/redemptions/${redemptionId}/approve`,
        headers: { 'x-admin-api-key': ADMIN_API_KEY, 'x-admin-user-id': reviewerAdmin },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<ErrorResponseBody>().error.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('rejects fulfillment-only role from approving', async () => {
      const userId = await createTestUser({ created_at: new Date() });
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });
      const created = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      const redemptionId = created.json<RedemptionResponseBody>().id;

      const fulfillmentAdmin = await createAdminUser('fulfillment');
      const res = await app.inject({
        method: 'POST',
        url: `/admin/redemptions/${redemptionId}/approve`,
        headers: adminHeaders(fulfillmentAdmin),
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('PayPal recipient', () => {
    it('requires the email, masks it for the user and shows it in full to fulfillment', async () => {
      const userId = await createTestUser({
        created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });
      const itemId = await createCatalogItem({ recipient_type: 'paypal_email' });
      const headers = { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` };

      const missing = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers,
        payload: { catalog_item_id: itemId },
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json<ErrorResponseBody>().error.code).toBe('RECIPIENT_REQUIRED');
      const wallet = await db
        .selectFrom('wallets')
        .select('available_coin')
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(wallet.available_coin).toBe('100000');

      const invalid = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers,
        payload: { catalog_item_id: itemId, recipient_email: 'not-an-email' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json<ErrorResponseBody>().error.code).toBe('VALIDATION_ERROR');

      const created = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers,
        payload: { catalog_item_id: itemId, recipient_email: 'alice@gmail.com' },
      });
      expect(created.statusCode).toBe(200);
      const body = created.json<RedemptionResponseBody & { recipient_email_masked: string }>();
      expect(body.recipient_email_masked).toBe('a***@gmail.com');
      expect(JSON.stringify(body)).not.toContain('alice');

      const adminId = await createAdminUser('fulfillment');
      const detail = await app.inject({
        method: 'GET',
        url: `/admin/redemptions/${body.id}`,
        headers: adminHeaders(adminId),
      });
      expect(detail.json<{ recipient_email: string }>().recipient_email).toBe('alice@gmail.com');
      const queue = await app.inject({
        method: 'GET',
        url: '/admin/redemptions?status=APPROVED',
        headers: adminHeaders(adminId),
      });
      const row = queue
        .json<{ items: { id: string; recipient_email: string | null }[] }>()
        .items.find((item) => item.id === body.id);
      expect(row?.recipient_email).toBe('alice@gmail.com');
    });

    it('ignores an email sent for a code reward', async () => {
      const userId = await createTestUser({
        created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });
      const itemId = await createCatalogItem();
      const res = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId, recipient_email: 'alice@gmail.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(
        res.json<{ recipient_email_masked: string | null }>().recipient_email_masked,
      ).toBeNull();
    });
  });

  describe('admin redemption queue', () => {
    it('includes the user and immutable reward information needed for fulfillment', async () => {
      const userId = await createTestUser({
        created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });
      const created = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      const redemptionId = created.json<RedemptionResponseBody>().id;
      await db
        .updateTable('catalog_items')
        .set({ title: 'Changed Later' })
        .where('id', '=', itemId)
        .execute();

      const adminId = await createAdminUser('fulfillment');
      const queue = await app.inject({
        method: 'GET',
        url: '/admin/redemptions?status=APPROVED',
        headers: adminHeaders(adminId),
      });
      expect(queue.statusCode).toBe(200);
      const item = queue
        .json<{
          items: {
            id: string;
            user: { id: string };
            reward: { title: string };
            catalog_item: { title: string };
          }[];
        }>()
        .items.find((row) => row.id === redemptionId);
      expect(item).toMatchObject({
        user: { id: userId },
        reward: { title: 'Test Gift Card' },
        catalog_item: { title: 'Test Gift Card' },
      });
    });
  });

  describe('admin transitions', () => {
    it('walks a redemption through approve -> fulfill -> paste-code -> DELIVERED', async () => {
      const userId = await createTestUser({
        created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });
      const created = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      const body = created.json<RedemptionResponseBody>();
      expect(body.status).toBe('APPROVED');
      const redemptionId = body.id;

      const superadminId = await createAdminUser('superadmin');

      const fulfillRes = await app.inject({
        method: 'POST',
        url: `/admin/redemptions/${redemptionId}/fulfill`,
        headers: adminHeaders(superadminId),
        payload: {},
      });
      expect(fulfillRes.statusCode).toBe(200);
      expect(fulfillRes.json<RedemptionResponseBody>().status).toBe('PURCHASING');

      const pasteRes = await app.inject({
        method: 'POST',
        url: `/admin/redemptions/${redemptionId}/paste-code`,
        headers: adminHeaders(superadminId),
        payload: { delivery_code: 'SECRET-CODE-1234', note: 'delivered manually' },
      });
      expect(pasteRes.statusCode).toBe(200);
      const pasteBody = pasteRes.json<RedemptionResponseBody>();
      expect(pasteBody.status).toBe('DELIVERED');
      expect(JSON.stringify(pasteBody)).not.toContain('SECRET-CODE-1234');

      const dbRow = await db
        .selectFrom('redemptions')
        .select('delivery_code')
        .where('id', '=', redemptionId)
        .executeTakeFirstOrThrow();
      expect(dbRow.delivery_code).not.toBeNull();
      expect(dbRow.delivery_code).not.toContain('SECRET-CODE-1234');

      const history = await db
        .selectFrom('redemption_status_history')
        .select('to_status')
        .where('redemption_id', '=', redemptionId)
        .orderBy('created_at', 'asc')
        .execute();
      expect(history.map((h) => h.to_status)).toEqual([
        'REQUESTED',
        'APPROVED',
        'PURCHASING',
        'DELIVERED',
      ]);

      const inbox = await db
        .selectFrom('inbox_messages')
        .selectAll()
        .where('user_id', '=', userId)
        .execute();
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.type).toBe('redemption_delivered');

      // Delivered but still inside the 48h claim hold counted from the request.
      const heldCodeRes = await app.inject({
        method: 'GET',
        url: `/redemptions/${redemptionId}/code`,
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(heldCodeRes.statusCode).toBe(409);
      expect(heldCodeRes.json<ErrorResponseBody>().error.code).toBe('REDEMPTION_HOLD_ACTIVE');

      await elapseClaimHold(redemptionId);
      await rateLimitRedis.del(`redemption-code:ratelimit:${userId}:${redemptionId}`);

      const ownerCodeRes = await app.inject({
        method: 'GET',
        url: `/redemptions/${redemptionId}/code`,
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(ownerCodeRes.statusCode).toBe(200);
      expect(ownerCodeRes.json<DeliveryCodeResponseBody>().delivery_code).toBe('SECRET-CODE-1234');

      const repeatedPaste = await app.inject({
        method: 'POST',
        url: `/admin/redemptions/${redemptionId}/paste-code`,
        headers: adminHeaders(superadminId),
        payload: { delivery_code: 'REPLACEMENT-CODE' },
      });
      expect(repeatedPaste.statusCode).toBe(409);
    });

    it('rejects an invalid transition (fulfill before approve)', async () => {
      const userId = await createTestUser({ created_at: new Date() });
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });
      const created = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      const redemptionId = created.json<RedemptionResponseBody>().id;
      expect(created.json<RedemptionResponseBody>().status).toBe('FRAUD_REVIEW');

      const superadminId = await createAdminUser('superadmin');
      const res = await app.inject({
        method: 'POST',
        url: `/admin/redemptions/${redemptionId}/fulfill`,
        headers: adminHeaders(superadminId),
        payload: {},
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<ErrorResponseBody>().error.code).toBe('INVALID_REDEMPTION_TRANSITION');
    });

    it('refunds on reject and rejects a repeated reject attempt without duplicating the refund', async () => {
      const userId = await createTestUser();
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });
      const created = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      const redemptionId = created.json<RedemptionResponseBody>().id;

      const reviewerId = await createAdminUser('reviewer');
      const rejectRes = await app.inject({
        method: 'POST',
        url: `/admin/redemptions/${redemptionId}/reject`,
        headers: adminHeaders(reviewerId),
        payload: { reason: 'Out of stock' },
      });
      expect(rejectRes.statusCode).toBe(200);
      expect(rejectRes.json<RedemptionResponseBody>().status).toBe('REJECTED');

      const secondRejectRes = await app.inject({
        method: 'POST',
        url: `/admin/redemptions/${redemptionId}/reject`,
        headers: adminHeaders(reviewerId),
        payload: { reason: 'Out of stock again' },
      });
      expect(secondRejectRes.statusCode).toBe(409);

      const refunds = await db
        .selectFrom('coin_ledger')
        .selectAll()
        .where('user_id', '=', userId)
        .where('entry_type', '=', 'REDEMPTION_REFUND')
        .execute();
      expect(refunds).toHaveLength(1);
    });
  });

  describe('GET /redemptions/:id/code', () => {
    async function createDeliveredRedemption(): Promise<{ userId: string; redemptionId: string }> {
      const userId = await createTestUser({
        created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
      });
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });
      const created = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      const redemptionId = created.json<RedemptionResponseBody>().id;
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
      // These cases cover code access itself; the hold is exercised separately in
      // redemption-claim-hold.test.ts.
      await elapseClaimHold(redemptionId);
      return { userId, redemptionId };
    }

    it('denies a non-owner from viewing the delivery code', async () => {
      const { redemptionId } = await createDeliveredRedemption();
      const otherUserId = await createTestUser();

      const res = await app.inject({
        method: 'GET',
        url: `/redemptions/${redemptionId}/code`,
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(otherUserId)}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('denies viewing the code before the redemption is delivered', async () => {
      const userId = await createTestUser();
      const itemId = await createCatalogItem({ usd_cost: '1.0000', coin_price: 1000 });
      const created = await app.inject({
        method: 'POST',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: { catalog_item_id: itemId },
      });
      const redemptionId = created.json<RedemptionResponseBody>().id;

      const res = await app.inject({
        method: 'GET',
        url: `/redemptions/${redemptionId}/code`,
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorResponseBody>().error.code).toBe('DELIVERY_CODE_UNAVAILABLE');
    });

    it('enforces a 5 requests/hour rate limit per user/redemption', async () => {
      const { userId, redemptionId } = await createDeliveredRedemption();
      await rateLimitRedis.del(`redemption-code:ratelimit:${userId}:${redemptionId}`);

      for (let i = 0; i < 5; i += 1) {
        const res = await app.inject({
          method: 'GET',
          url: `/redemptions/${redemptionId}/code`,
          headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        });
        expect(res.statusCode).toBe(200);
      }

      const sixth = await app.inject({
        method: 'GET',
        url: `/redemptions/${redemptionId}/code`,
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(sixth.statusCode).toBe(429);
    });

    it('inserts a REDEMPTION_CODE_VIEW audit row on access', async () => {
      const { userId, redemptionId } = await createDeliveredRedemption();
      await rateLimitRedis.del(`redemption-code:ratelimit:${userId}:${redemptionId}`);

      await app.inject({
        method: 'GET',
        url: `/redemptions/${redemptionId}/code`,
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });

      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('target_id', '=', redemptionId)
        .where('action', '=', 'REDEMPTION_CODE_VIEW')
        .execute();
      expect(audit).toHaveLength(1);
    });

    it('sets claimed_at on first owner access and keeps it stable on later views', async () => {
      const { userId, redemptionId } = await createDeliveredRedemption();
      await rateLimitRedis.del(`redemption-code:ratelimit:${userId}:${redemptionId}`);

      const first = await app.inject({
        method: 'GET',
        url: `/redemptions/${redemptionId}/code`,
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(first.statusCode).toBe(200);
      const firstClaim = await db
        .selectFrom('redemptions')
        .select('claimed_at')
        .where('id', '=', redemptionId)
        .executeTakeFirstOrThrow();
      expect(firstClaim.claimed_at).not.toBeNull();

      const second = await app.inject({
        method: 'GET',
        url: `/redemptions/${redemptionId}/code`,
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(second.statusCode).toBe(200);
      const secondClaim = await db
        .selectFrom('redemptions')
        .select('claimed_at')
        .where('id', '=', redemptionId)
        .executeTakeFirstOrThrow();
      expect(secondClaim.claimed_at?.toISOString()).toBe(firstClaim.claimed_at?.toISOString());

      const history = await app.inject({
        method: 'GET',
        url: '/redemptions',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      const receipt = history
        .json<RedemptionListResponseBody>()
        .items.find((item) => item.id === redemptionId);
      expect(receipt?.claimed_at).toBe(firstClaim.claimed_at?.toISOString());
    });
  });
});
