import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { rateLimitRedis } from '../../src/redis/index.js';

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

  describe('list, home and library', () => {
    it('filters by language and reports the total across pages', async () => {
      const regionId = await createRegion();
      const userId = await createUser(regionId);
      // A language code no other test uses keeps the count independent of the shared catalog.
      const language = `x${randomUUID().slice(0, 6)}`;
      for (let i = 0; i < 3; i += 1) await createNovel({ chapters: 1, language });
      await createNovel({ chapters: 1 });

      const first = await get(userId, `/novels?language=${language}&limit=2`);
      expect(first.statusCode).toBe(200);
      const page = first.json<{
        items: NovelSummaryBody[];
        next_cursor: string | null;
        total: number;
      }>();
      expect(page.total).toBe(3);
      expect(page.items).toHaveLength(2);
      expect(page.items.every((item) => item.language === language)).toBe(true);
      expect(page.next_cursor).toBe('2');

      const last = await get(userId, `/novels?language=${language}&limit=2&cursor=2`);
      expect(last.json<{ items: unknown[]; total: number }>()).toMatchObject({ total: 3 });
      expect(last.json<{ items: unknown[] }>().items).toHaveLength(1);
    });

    it('names the last chapter read on home and in the library', async () => {
      const regionId = await createRegion();
      const userId = await createUser(regionId);
      const { novelId } = await createNovel({ chapters: 3 });
      await get(userId, `/novels/${novelId}/chapters/2`);

      const home = await get(userId, '/novels/home');
      expect(home.statusCode).toBe(200);
      const row = home
        .json<{
          continue_reading: { novel: { id: string }; last_chapter_title: string | null }[];
        }>()
        .continue_reading.find((entry) => entry.novel.id === novelId);
      expect(row?.last_chapter_title).toBe('Chapter 2');

      const library = await get(userId, '/library?view=history');
      expect(library.statusCode).toBe(200);
      const item = library
        .json<{ items: { novel: { id: string }; last_chapter_title: string | null }[] }>()
        .items.find((entry) => entry.novel.id === novelId);
      expect(item?.last_chapter_title).toBe('Chapter 2');
    });

    it('returns a share link built from the novel slug', async () => {
      const regionId = await createRegion();
      const userId = await createUser(regionId);
      const { novelId } = await createNovel({ chapters: 1 });
      const { slug } = await db
        .selectFrom('novels')
        .select('slug')
        .where('id', '=', novelId)
        .executeTakeFirstOrThrow();

      const res = await get(userId, `/novels/${novelId}`);
      expect(res.json<{ share_url?: string }>().share_url).toBe(
        `https://links.ainovel.test/n/${slug}`,
      );
    });
  });

  describe('locked chapter preview', () => {
    interface LockedBody {
      error: { code: string; preview?: { title: string; text: string } };
    }

    it('shows the opening paragraphs of a VIP chapter the reader has not unlocked', async () => {
      const userId = await createUser(await createRegion());
      const { novelId } = await createNovel({
        chapters: 2,
        vipFrom: 2,
        content: (no) =>
          `  Opening of ${String(no)}.\r\n\r\nSecond line.\nThird line stays locked.`,
      });

      const res = await get(userId, `/novels/${novelId}/chapters/2`);
      expect(res.statusCode).toBe(403);
      expect(res.json<LockedBody>().error).toMatchObject({
        code: 'CHAPTER_LOCKED',
        preview: { title: 'Chapter 2', text: 'Opening of 2.\n\nSecond line.' },
      });
    });

    it('caps the preview at 800 characters on a word boundary', async () => {
      const userId = await createUser(await createRegion());
      const { novelId } = await createNovel({
        chapters: 1,
        vipFrom: 1,
        content: () => 'word '.repeat(1000),
      });

      const res = await get(userId, `/novels/${novelId}/chapters/1`);
      const text = res.json<LockedBody>().error.preview?.text ?? '';
      expect(text.length).toBeLessThanOrEqual(801);
      expect(text).toMatch(/word…$/);
    });
  });

  describe('hourly chapter limit', () => {
    it('answers with CHAPTER_HOURLY_LIMIT and when the window resets', async () => {
      const userId = await createUser(await createRegion());
      const { novelId } = await createNovel({ chapters: 1 });
      // Stand in for 300 chapters already opened this hour, with 20 minutes of the window left.
      await rateLimitRedis.set(`novel-chapter-read-hour:ratelimit:${userId}`, 300, 'EX', 1200);

      const before = Date.now();
      const res = await get(userId, `/novels/${novelId}/chapters/1`);
      expect(res.statusCode).toBe(429);
      const error = res.json<{ error: { code: string; retry_at: string } }>().error;
      expect(error.code).toBe('CHAPTER_HOURLY_LIMIT');
      const retryIn = Date.parse(error.retry_at) - before;
      expect(retryIn).toBeGreaterThan(1190_000);
      expect(retryIn).toBeLessThanOrEqual(1201_000);
    });
  });
});
