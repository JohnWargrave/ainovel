import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';

// Browsing surfaces the Novelico v3 UI reads: card fields, list totals and filters, the home rows,
// the locked-chapter preview and the hourly chapter limit.

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

interface NovelSummaryBody {
  id: string;
  language: string;
  rating: number | null;
  read_count: number;
  ai_generated: boolean;
  editor_reviewed: boolean;
}

async function createRegion(): Promise<string> {
  const regionId = `C_${randomUUID().slice(0, 8)}`;
  await db
    .insertInto('region_config')
    .values({ region_id: regionId, countries: [], features: { timezone: 'UTC' } })
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
      auth_subject: `catalog-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: regionId,
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId }).execute();
  return userId;
}

async function createNovel(options: {
  chapters: number;
  title?: string;
  language?: string;
  vipFrom?: number | null;
  rating?: number | null;
  aiGenerated?: boolean;
  content?: (no: number) => string;
}): Promise<{ novelId: string; chapterIds: string[] }> {
  const novelId = uuidv7();
  await db
    .insertInto('novels')
    .values({
      id: novelId,
      slug: `catalog-${randomUUID().slice(0, 12)}`,
      title: options.title ?? 'Catalog novel',
      author: 'Author',
      translator: null,
      description: null,
      cover_url: null,
      cover_key: null,
      status: 'published',
      language: options.language ?? 'vi',
      regions: null,
      vip_from_chapter: options.vipFrom ?? null,
      chapter_count: options.chapters,
      rating: options.rating ?? null,
      ai_generated: options.aiGenerated ?? false,
      published_at: new Date(),
      created_by: null,
    })
    .execute();
  const chapterIds: string[] = [];
  for (let no = 1; no <= options.chapters; no += 1) {
    const id = uuidv7();
    chapterIds.push(id);
    await db
      .insertInto('novel_chapters')
      .values({
        id,
        novel_id: novelId,
        chapter_no: no,
        title: `Chapter ${String(no)}`,
        content: options.content ? options.content(no) : `Body of chapter ${String(no)}`,
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

describe('novel catalog', () => {
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

  async function get(userId: string, url: string): Promise<ReturnType<FastifyInstance['inject']>> {
    return app.inject({ method: 'GET', url, headers: headers(userId) });
  }

  describe('story card fields', () => {
    it('exposes language, rating, AI disclosure and a distinct-reader count', async () => {
      const regionId = await createRegion();
      const [first, second] = [await createUser(regionId), await createUser(regionId)];
      const { novelId } = await createNovel({ chapters: 2, rating: 4.8, aiGenerated: true });

      const before = await get(first, `/novels/${novelId}`);
      expect(before.statusCode).toBe(200);
      expect(before.json<NovelSummaryBody>()).toMatchObject({
        language: 'vi',
        rating: 4.8,
        read_count: 0,
        ai_generated: true,
        editor_reviewed: false,
      });

      // A returning reader opening another chapter is still one reader.
      await get(first, `/novels/${novelId}/chapters/1`);
      await get(first, `/novels/${novelId}/chapters/2`);
      await get(second, `/novels/${novelId}/chapters/1`);

      const after = await get(first, `/novels/${novelId}`);
      expect(after.json<NovelSummaryBody>().read_count).toBe(2);
    });
  });
});
