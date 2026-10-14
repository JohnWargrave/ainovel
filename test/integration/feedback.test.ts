import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';

// POST /feedback from the app's "Rate the app" screen and POST /reports, with their CMS side.

const APP_HEADERS = {
  'x-app-version': '2.4.1',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};
const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

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

async function createChapter(): Promise<{ novelId: string; chapterId: string }> {
  const novelId = uuidv7();
  const chapterId = uuidv7();
  await db
    .insertInto('novels')
    .values({
      id: novelId,
      slug: `report-${randomUUID().slice(0, 12)}`,
      title: 'Reported novel',
      author: null,
      translator: null,
      description: null,
      cover_url: null,
      cover_key: null,
      status: 'published',
      language: 'vi',
      regions: null,
      vip_from_chapter: null,
      chapter_count: 1,
      published_at: new Date(),
      created_by: null,
    })
    .execute();
  await db
    .insertInto('novel_chapters')
    .values({
      id: chapterId,
      novel_id: novelId,
      chapter_no: 1,
      title: 'Chapter 1',
      content: 'Body',
      word_count: 1,
      is_vip: null,
      unlock_coin_price: null,
      status: 'published',
      publish_at: null,
    })
    .execute();
  return { novelId, chapterId };
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

  describe('content reports', () => {
    interface ReportItem {
      id: string;
      user_id: string;
      target_type: string;
      target_id: string | null;
      target_title: string | null;
      novel_id: string | null;
      reason: string;
      message: string | null;
      status: string;
      resolved_by: string | null;
    }

    async function report(
      userId: string,
      payload: Record<string, unknown>,
    ): Promise<ReturnType<FastifyInstance['inject']>> {
      return app.inject({ method: 'POST', url: '/reports', headers: headers(userId), payload });
    }

    async function reports(adminId: string, query = ''): Promise<ReportItem[]> {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/reports${query}`,
        headers: adminHeaders(adminId),
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ items: ReportItem[] }>().items;
    }

    it('files reports against a chapter, a novel or the app and names the target', async () => {
      const userId = await createUser();
      const { novelId, chapterId } = await createChapter();

      const chapter = await report(userId, {
        target_type: 'chapter',
        target_id: chapterId,
        reason: 'wrong_content',
        message: 'Paragraphs are repeated',
      });
      expect(chapter.statusCode).toBe(200);
      expect(chapter.json()).toMatchObject({ status: 'open' });
      const novel = await report(userId, {
        target_type: 'novel',
        target_id: novelId,
        reason: 'copyright',
      });
      // target_id is ignored for app reports.
      const appReport = await report(userId, {
        target_type: 'app',
        target_id: novelId,
        reason: 'other',
      });

      const editor = await createAdmin('editor');
      const items = await reports(editor);
      const byId = new Map(items.map((item) => [item.id, item]));
      expect(byId.get(chapter.json<{ id: string }>().id)).toMatchObject({
        user_id: userId,
        target_title: 'Reported novel · Chapter 1',
        novel_id: novelId,
        message: 'Paragraphs are repeated',
      });
      expect(byId.get(novel.json<{ id: string }>().id)).toMatchObject({
        target_title: 'Reported novel',
        novel_id: novelId,
      });
      expect(byId.get(appReport.json<{ id: string }>().id)).toMatchObject({
        target_id: null,
        target_title: null,
        novel_id: null,
      });
    });

    it('rejects a missing or unknown target', async () => {
      const userId = await createUser();
      const missing = await report(userId, { target_type: 'novel', reason: 'spam' });
      expect(missing.statusCode).toBe(400);
      const unknown = await report(userId, {
        target_type: 'chapter',
        target_id: uuidv7(),
        reason: 'spam',
      });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json<{ error: { code: string } }>().error.code).toBe(
        'REPORT_TARGET_NOT_FOUND',
      );
      expect((await report(userId, { target_type: 'app', reason: 'boring' })).statusCode).toBe(400);
    });

    it('lets staff close and reopen a report, with an audit trail', async () => {
      const userId = await createUser();
      const created = await report(userId, { target_type: 'app', reason: 'other' });
      const reportId = created.json<{ id: string }>().id;
      const reviewer = await createAdmin('reviewer');
      const update = async (status: string): Promise<ReturnType<FastifyInstance['inject']>> =>
        app.inject({
          method: 'POST',
          url: `/admin/reports/${reportId}`,
          headers: { ...adminHeaders(reviewer), 'x-csrf-token': ADMIN_CSRF_TOKEN },
          payload: { status, note: 'checked' },
        });

      const resolved = await update('resolved');
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json<ReportItem>()).toMatchObject({
        status: 'resolved',
        resolved_by: reviewer,
      });
      const open = await reports(reviewer, '?status=open&target_type=app');
      expect(open.some((item) => item.id === reportId)).toBe(false);

      const reopened = await update('open');
      expect(reopened.json<ReportItem>()).toMatchObject({ status: 'open', resolved_by: null });

      const audit = await db
        .selectFrom('audit_log')
        .select(['action', 'admin_user_id'])
        .where('target_id', '=', reportId)
        .execute();
      expect(audit).toHaveLength(2);
      expect(audit.every((entry) => entry.action === 'CONTENT_REPORT_STATUS_CHANGED')).toBe(true);

      const analyst = await createAdmin('analyst');
      const denied = await app.inject({
        method: 'POST',
        url: `/admin/reports/${reportId}`,
        headers: { ...adminHeaders(analyst), 'x-csrf-token': ADMIN_CSRF_TOKEN },
        payload: { status: 'dismissed' },
      });
      expect(denied.statusCode).toBe(403);
    });
  });
});
