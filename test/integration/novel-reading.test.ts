import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

const START = '2026-08-19T10:00:00Z';

// 600 words at 300 wpm × 0.5 = 60s required.
const WORDS = 600;
const REQUIRED_S = 60;

interface ErrorResponseBody {
  error: { code: string; message: string; unlock_price?: number; ad_unlock?: boolean };
}

interface HeartbeatBody {
  read_seconds: number;
  required_seconds: number;
  scroll_ratio: number;
  reward_eligible: boolean;
  boost_multiplier: number;
  rewarded: boolean;
  credited_coin: number;
  new_balance: string;
  daily_remaining: number;
}

interface UnlockResponseBody {
  chapter_id: string;
  unlocked: boolean;
  method: 'coin' | 'ad' | 'free';
  coin_spent: number;
  new_balance: string;
}

interface NovelOverrides {
  enabled?: boolean;
  chapter_reward_coin?: number;
  chapter_reward_daily_cap?: number;
}

async function createRegion(novel: NovelOverrides = {}): Promise<string> {
  const regionId = `N_${randomUUID().slice(0, 8)}`;
  await db
    .insertInto('region_config')
    .values({
      region_id: regionId,
      countries: [],
      features: {
        timezone: 'UTC',
        novel: {
          enabled: true,
          chapter_reward_coin: 10,
          reading_wpm: 300,
          min_read_ratio: 0.5,
          min_read_seconds: 30,
          max_read_seconds: 900,
          completion_scroll_ratio: 0.9,
          chapter_reward_daily_cap: 20,
          ...novel,
        },
      },
    })
    .execute();
  return regionId;
}

async function createUser(regionId: string, coin = 0, status = 'active'): Promise<string> {
  const userId = uuidv7();
  await db
    .insertInto('users')
    .values({
      id: userId,
      auth_provider: 'guest',
      auth_subject: `novel-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: regionId,
      status,
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId, available_coin: coin }).execute();
  return userId;
}

async function createNovel(options: {
  chapters: number;
  vipFrom?: number | null;
  unlockCoin?: number;
  allowAd?: boolean;
  regions?: string[] | null;
}): Promise<{ novelId: string; chapterIds: string[] }> {
  const novelId = uuidv7();
  await db
    .insertInto('novels')
    .values({
      id: novelId,
      slug: `novel-${randomUUID().slice(0, 12)}`,
      title: 'Test novel',
      author: 'Author',
      translator: null,
      description: null,
      cover_url: null,
      cover_key: null,
      status: 'published',
      regions: options.regions ?? null,
      vip_from_chapter: options.vipFrom ?? null,
      default_unlock_coin: options.unlockCoin ?? 50,
      allow_ad_unlock: options.allowAd ?? true,
      chapter_count: options.chapters,
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
        content: `Body of chapter ${String(no)}`,
        word_count: WORDS,
        is_vip: null,
        unlock_coin_price: null,
        status: 'published',
        publish_at: null,
      })
      .execute();
  }
  return { novelId, chapterIds };
}

async function creditRows(userId: string): Promise<{ entry_type: string; amount: string }[]> {
  return db
    .selectFrom('coin_ledger')
    .select(['entry_type', 'amount'])
    .where('user_id', '=', userId)
    .where('entry_type', 'in', ['NOVEL_READ_CREDIT', 'CHAPTER_UNLOCK_DEBIT'])
    .orderBy('created_at')
    .execute();
}

async function insertAdIntent(
  userId: string,
  regionId: string,
  placement: string | null,
  status = 'consumed',
): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('rewarded_ad_intents')
    .values({
      id,
      user_id: userId,
      region_id: regionId,
      status,
      placement,
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
    })
    .execute();
  return id;
}

describe('novel reading and unlocks', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;

  beforeAll(async () => {
    app = await buildApp();
    accessJwt = (app.jwt as unknown as { access: JWT }).access;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await app.close();
  });

  function headers(userId: string): Record<string, string> {
    const token = accessJwt.sign({ sub: userId, trust_level: 0 });
    return { ...APP_HEADERS, authorization: `Bearer ${token}` };
  }

  // Only Date is faked; the DB and Redis clients still need real timers to resolve.
  function at(iso: string): void {
    vi.setSystemTime(new Date(iso));
  }

  function plus(seconds: number): string {
    return new Date(new Date(START).getTime() + seconds * 1000).toISOString();
  }

  async function beat(userId: string, chapterId: string, scroll = 1): Promise<HeartbeatBody> {
    const res = await app.inject({
      method: 'POST',
      url: '/novels/read-heartbeat',
      headers: headers(userId),
      payload: { chapter_id: chapterId, scroll_ratio: scroll },
    });
    expect(res.statusCode).toBe(200);
    return res.json<HeartbeatBody>();
  }

  async function unlock(
    userId: string,
    chapterId: string,
    payload: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: UnlockResponseBody & ErrorResponseBody }> {
    const res = await app.inject({
      method: 'POST',
      url: `/novels/chapters/${chapterId}/unlock`,
      headers: headers(userId),
      payload,
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

  describe('read heartbeat', () => {
    it('credits a free chapter once, after the server-measured read time and full scroll', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      at(START);
      const regionId = await createRegion();
      const userId = await createUser(regionId);
      const { chapterIds } = await createNovel({ chapters: 1 });
      const chapterId = chapterIds[0] ?? '';

      const first = await beat(userId, chapterId);
      // The first beat only sets the baseline.
      expect(first).toMatchObject({
        read_seconds: 0,
        required_seconds: REQUIRED_S,
        reward_eligible: true,
        rewarded: false,
      });

      at(plus(30));
      expect((await beat(userId, chapterId)).rewarded).toBe(false);
      at(plus(60));
      const third = await beat(userId, chapterId);
      expect(third).toMatchObject({
        read_seconds: 60,
        rewarded: true,
        credited_coin: 10,
        new_balance: '10',
        daily_remaining: 19,
      });

      at(plus(90));
      const again = await beat(userId, chapterId);
      expect(again.rewarded).toBe(false);
      expect(await creditRows(userId)).toEqual([{ entry_type: 'NOVEL_READ_CREDIT', amount: '10' }]);
    });

    it('multiplies the chapter reward while a boost is running', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      at(START);
      const userId = await createUser(await createRegion());
      const { chapterIds } = await createNovel({ chapters: 2 });
      await db
        .insertInto('user_boosts')
        .values({
          id: uuidv7(),
          user_id: userId,
          multiplier: 2,
          starts_at: new Date(START),
          expires_at: new Date(Date.parse(START) + 100_000),
          source: 'spin',
          source_id: null,
        })
        .execute();

      const boosted = chapterIds[0] ?? '';
      expect((await beat(userId, boosted)).boost_multiplier).toBe(2);
      at(plus(30));
      await beat(userId, boosted);
      at(plus(60));
      expect(await beat(userId, boosted)).toMatchObject({ rewarded: true, credited_coin: 20 });

      // Past the boost window the next chapter pays the plain rate.
      const plain = chapterIds[1] ?? '';
      at(plus(120));
      expect((await beat(userId, plain)).boost_multiplier).toBe(1);
      at(plus(150));
      await beat(userId, plain);
      at(plus(180));
      expect(await beat(userId, plain)).toMatchObject({ rewarded: true, credited_coin: 10 });
    });

    it('caps one beat so a backgrounded app cannot bank the whole gap', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      at(START);
      const userId = await createUser(await createRegion());
      const { chapterIds } = await createNovel({ chapters: 1 });
      const chapterId = chapterIds[0] ?? '';

      await beat(userId, chapterId);
      at(plus(3600));
      const late = await beat(userId, chapterId);
      expect(late.read_seconds).toBe(30);
      expect(late.rewarded).toBe(false);
    });

    it('does not pay until the reader has scrolled to the end', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      at(START);
      const userId = await createUser(await createRegion());
      const { chapterIds } = await createNovel({ chapters: 1 });
      const chapterId = chapterIds[0] ?? '';

      await beat(userId, chapterId, 0.1);
      at(plus(30));
      await beat(userId, chapterId, 0.3);
      at(plus(60));
      const enoughTime = await beat(userId, chapterId, 0.5);
      expect(enoughTime).toMatchObject({ read_seconds: 60, rewarded: false });

      at(plus(61));
      const scrolled = await beat(userId, chapterId, 0.95);
      expect(scrolled.rewarded).toBe(true);
    });

    it('accrues time only on the active chapter', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      at(START);
      const userId = await createUser(await createRegion());
      const { chapterIds } = await createNovel({ chapters: 2 });
      const [a = '', b = ''] = chapterIds;

      // Alternating beats between two chapters: each beat finds the other chapter active.
      for (let step = 0; step < 6; step += 1) {
        at(plus(step * 10));
        await beat(userId, step % 2 === 0 ? a : b);
      }
      // The last loop beat was on b, so a is still not the active chapter.
      at(plus(60));
      const result = await beat(userId, a);
      expect(result.read_seconds).toBe(0);
      expect(await creditRows(userId)).toEqual([]);
    });

    it('stops paying at the daily cap', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      at(START);
      const userId = await createUser(await createRegion({ chapter_reward_daily_cap: 1 }));
      const { chapterIds } = await createNovel({ chapters: 2 });
      const [a = '', b = ''] = chapterIds;

      await beat(userId, a);
      at(plus(30));
      await beat(userId, a);
      at(plus(60));
      expect((await beat(userId, a)).rewarded).toBe(true);

      at(plus(61));
      await beat(userId, b);
      at(plus(91));
      await beat(userId, b);
      at(plus(121));
      const capped = await beat(userId, b);
      expect(capped).toMatchObject({ read_seconds: 60, rewarded: false, daily_remaining: 0 });
      expect(await creditRows(userId)).toHaveLength(1);
    });

    it('tracks but never pays an unlocked VIP chapter', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      at(START);
      const userId = await createUser(await createRegion(), 100);
      const { chapterIds } = await createNovel({ chapters: 1, vipFrom: 1, unlockCoin: 20 });
      const chapterId = chapterIds[0] ?? '';

      expect((await unlock(userId, chapterId, { method: 'coin' })).statusCode).toBe(200);
      const first = await beat(userId, chapterId);
      expect(first.reward_eligible).toBe(false);
      at(plus(30));
      await beat(userId, chapterId);
      at(plus(60));
      const done = await beat(userId, chapterId);
      expect(done).toMatchObject({ read_seconds: 60, rewarded: false });
      expect(await creditRows(userId)).toEqual([
        { entry_type: 'CHAPTER_UNLOCK_DEBIT', amount: '-20' },
      ]);
    });

    it('rejects a heartbeat on a locked VIP chapter', async () => {
      const userId = await createUser(await createRegion());
      const { chapterIds } = await createNovel({ chapters: 1, vipFrom: 1 });
      const res = await app.inject({
        method: 'POST',
        url: '/novels/read-heartbeat',
        headers: headers(userId),
        payload: { chapter_id: chapterIds[0], scroll_ratio: 0 },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<ErrorResponseBody>().error.code).toBe('CHAPTER_LOCKED');
    });

    it('404s a chapter that does not exist', async () => {
      const userId = await createUser(await createRegion());
      const res = await app.inject({
        method: 'POST',
        url: '/novels/read-heartbeat',
        headers: headers(userId),
        payload: { chapter_id: uuidv7(), scroll_ratio: 0 },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<ErrorResponseBody>().error.code).toBe('CHAPTER_NOT_FOUND');
    });

    it('pays nothing while the region has rewards off', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      at(START);
      const userId = await createUser(await createRegion({ enabled: false }));
      const { chapterIds } = await createNovel({ chapters: 1 });
      const chapterId = chapterIds[0] ?? '';

      await beat(userId, chapterId);
      at(plus(30));
      await beat(userId, chapterId);
      at(plus(60));
      const done = await beat(userId, chapterId);
      expect(done).toMatchObject({ reward_eligible: false, rewarded: false });
      expect(await creditRows(userId)).toEqual([]);
    });
  });

  describe('reading a chapter', () => {
    it('serves free chapters and locks VIP ones with the unlock price', async () => {
      const userId = await createUser(await createRegion());
      const { novelId } = await createNovel({ chapters: 2, vipFrom: 2, unlockCoin: 35 });

      const free = await app.inject({
        method: 'GET',
        url: `/novels/${novelId}/chapters/1`,
        headers: headers(userId),
      });
      expect(free.statusCode).toBe(200);
      expect(free.json()).toMatchObject({
        chapter_no: 1,
        content: 'Body of chapter 1',
        is_vip: false,
        prev_chapter_no: null,
        next_chapter_no: 2,
      });

      const locked = await app.inject({
        method: 'GET',
        url: `/novels/${novelId}/chapters/2`,
        headers: headers(userId),
      });
      expect(locked.statusCode).toBe(403);
      expect(locked.json<ErrorResponseBody>().error).toMatchObject({
        code: 'CHAPTER_LOCKED',
        unlock_price: 35,
        ad_unlock: true,
      });
    });

    it('hides novels not licensed for the reader', async () => {
      const userId = await createUser(await createRegion());
      const { novelId } = await createNovel({ chapters: 1, regions: ['US'] });
      const res = await app.inject({
        method: 'GET',
        url: `/novels/${novelId}`,
        headers: headers(userId),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('unlocking with coin', () => {
    it('debits the price once and then serves the chapter', async () => {
      const userId = await createUser(await createRegion(), 100);
      const { novelId, chapterIds } = await createNovel({
        chapters: 1,
        vipFrom: 1,
        unlockCoin: 40,
      });
      const chapterId = chapterIds[0] ?? '';

      const first = await unlock(userId, chapterId, { method: 'coin' });
      expect(first.statusCode).toBe(200);
      expect(first.body).toMatchObject({ method: 'coin', coin_spent: 40, new_balance: '60' });

      // A retry reports the original unlock without charging again.
      const retry = await unlock(userId, chapterId, { method: 'coin' });
      expect(retry.body).toMatchObject({ method: 'coin', coin_spent: 40, new_balance: '60' });
      expect(await creditRows(userId)).toEqual([
        { entry_type: 'CHAPTER_UNLOCK_DEBIT', amount: '-40' },
      ]);

      const read = await app.inject({
        method: 'GET',
        url: `/novels/${novelId}/chapters/1`,
        headers: headers(userId),
      });
      expect(read.statusCode).toBe(200);
    });

    it('rejects an unlock the wallet cannot cover and records nothing', async () => {
      const userId = await createUser(await createRegion(), 10);
      const { chapterIds } = await createNovel({ chapters: 1, vipFrom: 1, unlockCoin: 40 });
      const chapterId = chapterIds[0] ?? '';

      const res = await unlock(userId, chapterId, { method: 'coin' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
      const unlocks = await db
        .selectFrom('novel_chapter_unlocks')
        .select('id')
        .where('user_id', '=', userId)
        .execute();
      expect(unlocks).toEqual([]);
    });

    it('reports a free chapter as already open without charging', async () => {
      const userId = await createUser(await createRegion(), 10);
      const { chapterIds } = await createNovel({ chapters: 1 });
      const res = await unlock(userId, chapterIds[0] ?? '', { method: 'coin' });
      expect(res.body).toMatchObject({ method: 'free', coin_spent: 0, new_balance: '10' });
    });
  });

  describe('unlocking with a rewarded ad', () => {
    it('accepts a verified chapter_unlock intent exactly once', async () => {
      const regionId = await createRegion();
      const userId = await createUser(regionId);
      const { chapterIds } = await createNovel({ chapters: 2, vipFrom: 1 });
      const [a = '', b = ''] = chapterIds;
      const intentId = await insertAdIntent(userId, regionId, 'chapter_unlock');

      const res = await unlock(userId, a, { method: 'ad', intent_id: intentId });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ method: 'ad', coin_spent: 0 });

      // The same ad cannot open a second chapter.
      const reuse = await unlock(userId, b, { method: 'ad', intent_id: intentId });
      expect(reuse.statusCode).toBe(403);
      expect(reuse.body.error.code).toBe('AD_NOT_VERIFIED');
    });

    it.each([
      ['another placement', 'luckyspin', 'consumed'],
      ['a legacy intent without placement', null, 'consumed'],
      ['an unverified intent', 'chapter_unlock', 'pending'],
    ])('rejects %s', async (_label, placement, status) => {
      const regionId = await createRegion();
      const userId = await createUser(regionId);
      const { chapterIds } = await createNovel({ chapters: 1, vipFrom: 1 });
      const intentId = await insertAdIntent(userId, regionId, placement, status);

      const res = await unlock(userId, chapterIds[0] ?? '', { method: 'ad', intent_id: intentId });
      expect(res.statusCode).toBe(403);
      expect(res.body.error.code).toBe('AD_NOT_VERIFIED');
    });

    it("rejects another user's intent", async () => {
      const regionId = await createRegion();
      const owner = await createUser(regionId);
      const thief = await createUser(regionId);
      const { chapterIds } = await createNovel({ chapters: 1, vipFrom: 1 });
      const intentId = await insertAdIntent(owner, regionId, 'chapter_unlock');

      const res = await unlock(thief, chapterIds[0] ?? '', { method: 'ad', intent_id: intentId });
      expect(res.statusCode).toBe(403);
    });

    it('refuses ad unlocks on a novel that disallows them', async () => {
      const regionId = await createRegion();
      const userId = await createUser(regionId);
      const { chapterIds } = await createNovel({ chapters: 1, vipFrom: 1, allowAd: false });
      const intentId = await insertAdIntent(userId, regionId, 'chapter_unlock');

      const res = await unlock(userId, chapterIds[0] ?? '', { method: 'ad', intent_id: intentId });
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe('AD_UNLOCK_DISABLED');
    });
  });
});
