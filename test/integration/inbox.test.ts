import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';

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

interface InboxMessageBody {
  id: string;
  type: string;
  title: string;
  body: string;
  payload: unknown;
  read_at: string | null;
  created_at: string;
}

interface InboxListBody {
  items: InboxMessageBody[];
  next_cursor: string | null;
  unread_count: number;
}

async function createUser(): Promise<string> {
  const userId = uuidv7();
  await db
    .insertInto('users')
    .values({
      id: userId,
      auth_provider: 'guest',
      auth_subject: `inbox-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: 'VN',
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

async function seedMessage(userId: string, index: number): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('inbox_messages')
    .values({
      id,
      user_id: userId,
      type: 'system',
      title: `Message ${String(index)}`,
      body: 'body',
      payload: JSON.stringify({ index }),
    })
    .execute();
  return id;
}

describe('inbox', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;

  beforeAll(async () => {
    app = await buildApp();
    accessJwt = (app.jwt as unknown as { access: JWT }).access;
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

  // The only production writer of inbox_messages is the delivery-code paste, so the test drives the
  // real admin flow end to end rather than inserting a row by hand — otherwise nothing proves the
  // two halves are actually connected.
  it('surfaces the message written when an admin delivers a redemption code', async () => {
    const userId = await createUser();
    const fulfillmentId = await createAdminUser('fulfillment');

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

    const redemptionId = uuidv7();
    await db
      .insertInto('redemptions')
      .values({
        id: redemptionId,
        user_id: userId,
        catalog_item_id: itemId,
        coin_price: 1000,
        usd_cost_est: '1.0000',
        reward_snapshot: {
          sku: 'inbox-gift-card',
          title: 'Gift Card',
          category: 'gift_card',
          face_value: '$1',
          image_url: null,
        },
        status: 'PURCHASING',
      })
      .execute();

    const deliver = await app.inject({
      method: 'POST',
      url: `/admin/redemptions/${redemptionId}/paste-code`,
      headers: adminHeaders(fulfillmentId),
      payload: { delivery_code: 'CODE-1234-5678' },
    });
    expect(deliver.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/inbox', headers: auth(userId) });
    expect(list.statusCode).toBe(200);
    const body = list.json<InboxListBody>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.type).toBe('redemption_delivered');
    expect(body.unread_count).toBe(1);

    // The delivery code itself must never ride along in the inbox payload — GET /redemptions/:id/code
    // is the only endpoint that decrypts it.
    expect(JSON.stringify(body.items[0]?.payload)).not.toContain('CODE-1234-5678');
    expect(body.items[0]?.payload).toEqual({
      redemption_id: redemptionId,
      catalog_item_id: itemId,
    });
  });

  it('never returns another user’s messages', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const messageId = await seedMessage(owner, 1);

    const list = await app.inject({ method: 'GET', url: '/inbox', headers: auth(stranger) });
    expect(list.json<InboxListBody>().items).toHaveLength(0);

    // 404, not 403: a 403 would confirm the id exists.
    const detail = await app.inject({
      method: 'GET',
      url: `/inbox/${messageId}`,
      headers: auth(stranger),
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json<ErrorResponseBody>().error.code).toBe('NOT_FOUND');

    const read = await app.inject({
      method: 'POST',
      url: `/inbox/${messageId}/read`,
      headers: auth(stranger),
    });
    expect(read.statusCode).toBe(404);

    const stillUnread = await db
      .selectFrom('inbox_messages')
      .select('read_at')
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
    expect(stillUnread.read_at).toBeNull();
  });

  it('marks a message read idempotently', async () => {
    const userId = await createUser();
    const messageId = await seedMessage(userId, 1);
    await seedMessage(userId, 2);

    const first = await app.inject({
      method: 'POST',
      url: `/inbox/${messageId}/read`,
      headers: auth(userId),
    });
    expect(first.statusCode).toBe(200);
    const firstReadAt = first.json<InboxMessageBody>().read_at;
    expect(firstReadAt).not.toBeNull();

    const second = await app.inject({
      method: 'POST',
      url: `/inbox/${messageId}/read`,
      headers: auth(userId),
    });
    expect(second.statusCode).toBe(200);
    // Same timestamp on the second call — "when did the user first see this" must stay answerable.
    expect(second.json<InboxMessageBody>().read_at).toBe(firstReadAt);

    const list = await app.inject({ method: 'GET', url: '/inbox', headers: auth(userId) });
    expect(list.json<InboxListBody>().unread_count).toBe(1);
  });

  it('pages through the cursor without gaps or duplicates', async () => {
    const userId = await createUser();
    const seeded: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      seeded.push(await seedMessage(userId, i));
    }

    const first = await app.inject({
      method: 'GET',
      url: '/inbox?limit=20',
      headers: auth(userId),
    });
    const firstBody = first.json<InboxListBody>();
    expect(firstBody.items).toHaveLength(20);
    expect(firstBody.next_cursor).not.toBeNull();

    const second = await app.inject({
      method: 'GET',
      url: `/inbox?limit=20&cursor=${String(firstBody.next_cursor)}`,
      headers: auth(userId),
    });
    const secondBody = second.json<InboxListBody>();
    expect(secondBody.items).toHaveLength(5);
    expect(secondBody.next_cursor).toBeNull();

    const seen = [...firstBody.items, ...secondBody.items].map((item) => item.id);
    expect(new Set(seen).size).toBe(25);
    // uuidv7 ids sort by creation time, so the page order is newest-first.
    expect(seen).toEqual([...seeded].reverse());
  });

  it('requires a bearer token and answers on the /v1 alias', async () => {
    const userId = await createUser();
    await seedMessage(userId, 1);

    const anonymous = await app.inject({ method: 'GET', url: '/inbox', headers: APP_HEADERS });
    expect(anonymous.statusCode).toBe(401);

    const v1 = await app.inject({ method: 'GET', url: '/v1/inbox', headers: auth(userId) });
    expect(v1.statusCode).toBe(200);
    expect(v1.json<InboxListBody>().items).toHaveLength(1);
  });

  it('rejects a malformed message id with 400 rather than a database error', async () => {
    const userId = await createUser();
    const res = await app.inject({
      method: 'GET',
      url: '/inbox/not-a-uuid',
      headers: auth(userId),
    });
    expect(res.statusCode).toBe(400);
  });
});
