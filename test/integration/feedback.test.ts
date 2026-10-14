import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';

// POST /feedback from the app's "Rate the app" screen, and the read-only CMS list.

const APP_HEADERS = {
  'x-app-version': '2.4.1',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};
const ADMIN_API_KEY = 'test-admin-api-key';

interface FeedbackItem {
  id: string;
  user_id: string;
  public_id: string;
  rating: number;
  message: string | null;
  email: string | null;
  app_version: string | null;
}

async function createUser(): Promise<string> {
  const userId = uuidv7();
  await db
    .insertInto('users')
    .values({
      id: userId,
      auth_provider: 'guest',
      auth_subject: `feedback-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: 'VN',
    })
    .execute();
  return userId;
}

async function createAdmin(role: string): Promise<string> {
  const adminId = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id: adminId, email: `admin-${randomUUID()}@test.local`, role })
    .execute();
  return adminId;
}

describe('app feedback', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;

  beforeAll(async () => {
    app = await buildApp();
    accessJwt = (app.jwt as unknown as { access: JWT }).access;
  });

  afterAll(async () => {
    await app.close();
  });

  function headers(userId: string): Record<string, string> {
    return {
      ...APP_HEADERS,
      authorization: `Bearer ${accessJwt.sign({ sub: userId, trust_level: 0 })}`,
    };
  }

  function adminHeaders(adminId: string): Record<string, string> {
    return { 'x-admin-api-key': ADMIN_API_KEY, 'x-admin-user-id': adminId };
  }

  async function send(
    userId: string,
    payload: Record<string, unknown>,
  ): Promise<ReturnType<FastifyInstance['inject']>> {
    return app.inject({ method: 'POST', url: '/feedback', headers: headers(userId), payload });
  }

  async function adminList(adminId: string, query = ''): Promise<FeedbackItem[]> {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/feedback${query}`,
      headers: adminHeaders(adminId),
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ items: FeedbackItem[] }>().items;
  }

  it('records a rating with an optional message and reply address', async () => {
    const userId = await createUser();
    const res = await send(userId, {
      rating: 4,
      message: '  Love the reader, wish it had dark mode  ',
      email: 'reader@example.com',
    });
    expect(res.statusCode).toBe(200);
    const { id } = res.json<{ id: string }>();

    const analyst = await createAdmin('analyst');
    const item = (await adminList(analyst)).find((entry) => entry.id === id);
    expect(item).toMatchObject({
      user_id: userId,
      rating: 4,
      message: 'Love the reader, wish it had dark mode',
      email: 'reader@example.com',
      app_version: '2.4.1',
    });
    expect(item?.public_id).toMatch(/^\d+$/);

    const fives = await adminList(analyst, '?rating=5');
    expect(fives.some((entry) => entry.id === id)).toBe(false);
  });

  it('rejects ratings outside 1–5 and limits a reader to five an hour', async () => {
    const userId = await createUser();
    expect((await send(userId, { rating: 0 })).statusCode).toBe(400);
    expect((await send(userId, { rating: 6 })).statusCode).toBe(400);
    expect((await send(userId, { rating: 3, email: 'nope' })).statusCode).toBe(400);

    // The three rejected bodies failed validation before reaching the rate limit.
    for (let i = 0; i < 5; i += 1) {
      expect((await send(userId, { rating: 5 })).statusCode).toBe(200);
    }
    const limited = await send(userId, { rating: 5 });
    expect(limited.statusCode).toBe(429);
  });

  it('keeps the list away from fulfillment staff', async () => {
    const fulfillment = await createAdmin('fulfillment');
    const res = await app.inject({
      method: 'GET',
      url: '/admin/feedback',
      headers: adminHeaders(fulfillment),
    });
    expect(res.statusCode).toBe(403);
  });
});
