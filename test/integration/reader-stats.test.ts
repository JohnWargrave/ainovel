import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';

// GET /me/stats: the profile screen's chapters read, reading time and check-in streak.

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

interface StatsBody {
  chapters_read: number;
  reading_seconds: number;
  checkin_streak: number;
}

async function createUser(): Promise<string> {
  const regionId = `S_${randomUUID().slice(0, 8)}`;
  await db
    .insertInto('region_config')
    .values({
      region_id: regionId,
      countries: [],
      features: { timezone: 'UTC', checkin: { enabled: true, rewards: [10] } },
    })
    .execute();
  const userId = uuidv7();
  await db
    .insertInto('users')
    .values({
      id: userId,
      auth_provider: 'guest',
      auth_subject: `stats-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: regionId,
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId }).execute();
  return userId;
}

async function createChapters(count: number): Promise<{ novelId: string; chapterIds: string[] }> {
  const novelId = uuidv7();
  await db
    .insertInto('novels')
    .values({
      id: novelId,
      slug: `stats-${randomUUID().slice(0, 12)}`,
      title: 'Stats novel',
      author: null,
      translator: null,
      description: null,
      cover_url: null,
      cover_key: null,
      status: 'published',
      language: 'vi',
      regions: null,
      vip_from_chapter: null,
      chapter_count: count,
      published_at: new Date(),
      created_by: null,
    })
    .execute();
  const chapterIds: string[] = [];
  for (let no = 1; no <= count; no += 1) {
    const id = uuidv7();
    chapterIds.push(id);
    await db
      .insertInto('novel_chapters')
      .values({
        id,
        novel_id: novelId,
        chapter_no: no,
        title: `Chapter ${String(no)}`,
        content: 'Body',
        word_count: 600,
        is_vip: null,
        unlock_coin_price: null,
        status: 'published',
        publish_at: null,
      })
      .execute();
  }
  return { novelId, chapterIds };
}

describe('GET /me/stats', () => {
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
    const token = accessJwt.sign({ sub: userId, trust_level: 0 });
    return { ...APP_HEADERS, authorization: `Bearer ${token}` };
  }

  it('is all zero for a new reader', async () => {
    const userId = await createUser();
    const res = await app.inject({ method: 'GET', url: '/me/stats', headers: headers(userId) });
    expect(res.statusCode).toBe(200);
    expect(res.json<StatsBody>()).toEqual({
      chapters_read: 0,
      reading_seconds: 0,
      checkin_streak: 0,
    });
  });

  it('counts finished chapters, sums reading time and reports the check-in streak', async () => {
    const userId = await createUser();
    const { novelId, chapterIds } = await createChapters(3);
    const now = new Date();
    await db
      .insertInto('novel_read_progress')
      .values(
        chapterIds.map((chapterId, index) => ({
          id: uuidv7(),
          user_id: userId,
          chapter_id: chapterId,
          novel_id: novelId,
          read_time_s: 100 * (index + 1),
          last_heartbeat_at: now,
          // The third chapter was opened but not finished.
          completed_at: index < 2 ? now : null,
        })),
      )
      .execute();
    const claim = await app.inject({
      method: 'POST',
      url: '/checkin/claim',
      headers: headers(userId),
    });
    expect(claim.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/me/stats', headers: headers(userId) });
    expect(res.json<StatsBody>()).toEqual({
      chapters_read: 2,
      reading_seconds: 600,
      checkin_streak: 1,
    });
  });
});
