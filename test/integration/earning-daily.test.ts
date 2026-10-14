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

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_TASKS = [
  {
    id: 'daily_login',
    title: 'Daily Login',
    description: 'Log in today',
    reward_coin: 10,
    task_type: 'daily_login',
  },
  {
    id: 'share_app',
    title: 'Share the App',
    description: 'Share with friends',
    reward_coin: 50,
    task_type: 'share_app',
  },
];

interface ErrorResponseBody {
  error: { code: string; message: string };
}

interface CheckinStateBody {
  enabled: boolean;
  streak_day: number;
  days_claimed: number;
  today_claimed: boolean;
  rewards: number[];
  next_reward_coin: number;
  reset_at: string;
}

interface CheckinClaimBody {
  credited_coin: number;
  new_balance: string;
  streak_day: number;
}

interface TaskListBody {
  tasks: {
    id: string;
    task_type: string;
    reward_coin: number;
    completed_today: boolean;
    icon_url: string | null;
    action: string | null;
    status: 'available' | 'completed';
    progress: number;
    target: number;
  }[];
  reset_at: string;
}

interface TaskClaimBody {
  task_id: string;
  credited_coin: number;
  new_balance: string;
}

async function createRegion(features: Record<string, unknown>): Promise<string> {
  const regionId = `T_${randomUUID().slice(0, 8)}`;
  await db
    .insertInto('region_config')
    .values({ region_id: regionId, countries: [], features })
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
      auth_subject: `test-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: regionId,
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId, available_coin: 0 }).execute();
  return userId;
}

// Backdated ledger rows stand in for check-ins on previous days — the service reads created_at, so
// the streak walk-back can be exercised without waiting a week.
async function seedCheckin(userId: string, daysAgo: number, amount = 10): Promise<void> {
  await db
    .insertInto('coin_ledger')
    .values({
      id: uuidv7(),
      user_id: userId,
      entry_type: 'CHECKIN_CREDIT',
      amount,
      bucket: 'available',
      balance_after: 0,
      idempotency_key: `seed:${userId}:${String(daysAgo)}`,
      created_at: new Date(Date.now() - daysAgo * DAY_MS),
    })
    .execute();
}

describe('daily earning (check-in + tasks)', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;

  beforeAll(async () => {
    app = await buildApp();
    accessJwt = (app.jwt as unknown as { access: JWT }).access;
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function tokenFor(userId: string): string {
    return accessJwt.sign({ sub: userId, trust_level: 0 });
  }

  function auth(userId: string): Record<string, string> {
    return { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` };
  }

  async function enabledRegion(overrides?: {
    timezone?: string;
    rewards?: number[];
    tasks?: unknown;
    checkinEnabled?: boolean;
  }): Promise<string> {
    const features: Record<string, unknown> = {
      timezone: overrides?.timezone ?? 'UTC',
      checkin: {
        enabled: overrides?.checkinEnabled ?? true,
        rewards: overrides?.rewards ?? [10, 15, 20, 25, 30, 40, 100],
      },
    };
    if (overrides?.tasks !== null) {
      features['tasks'] = overrides?.tasks ?? { enabled: true, list: DEFAULT_TASKS };
    }
    return createRegion(features);
  }

  it('reports an unclaimed first day', async () => {
    const userId = await createUser(await enabledRegion());
    const res = await app.inject({
      method: 'GET',
      url: '/checkin/state',
      headers: auth(userId),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<CheckinStateBody>();
    expect(body.enabled).toBe(true);
    expect(body.today_claimed).toBe(false);
    expect(body.streak_day).toBe(1);
    // A fresh account has completed nothing: day 1 is still up for grabs, not already behind it.
    expect(body.days_claimed).toBe(0);
    expect(body.next_reward_coin).toBe(body.rewards[0]);
    expect(Date.parse(body.reset_at)).toBeGreaterThan(Date.now());
  });

  it('claims once per day and reflects it in state', async () => {
    const userId = await createUser(await enabledRegion());

    const claim = await app.inject({
      method: 'POST',
      url: '/checkin/claim',
      headers: auth(userId),
    });
    expect(claim.statusCode).toBe(200);
    const claimBody = claim.json<CheckinClaimBody>();
    expect(claimBody.streak_day).toBe(1);
    expect(claimBody.credited_coin).toBe(10);
    expect(claimBody.new_balance).toBe('10');

    const wallet = await db
      .selectFrom('wallets')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(wallet.available_coin).toBe('10');

    const again = await app.inject({
      method: 'POST',
      url: '/checkin/claim',
      headers: auth(userId),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<ErrorResponseBody>().error.code).toBe('ALREADY_CLAIMED');

    const state = await app.inject({
      method: 'GET',
      url: '/checkin/state',
      headers: auth(userId),
    });
    const stateBody = state.json<CheckinStateBody>();
    expect(stateBody.today_claimed).toBe(true);
    expect(stateBody.streak_day).toBe(1);
    expect(stateBody.days_claimed).toBe(1);
    // Already claimed today, so the next payout is tomorrow's tier.
    expect(stateBody.next_reward_coin).toBe(stateBody.rewards[1]);
  });

  describe('check-in ad bonus', () => {
    async function checkinIntent(
      userId: string,
      overrides?: { status?: string; placement?: string },
    ): Promise<string> {
      const id = uuidv7();
      await db
        .insertInto('rewarded_ad_intents')
        .values({
          id,
          user_id: userId,
          region_id: 'VN',
          status: overrides?.status ?? 'consumed',
          placement: overrides?.placement ?? 'checkin',
          expires_at: new Date(Date.now() + 10 * 60 * 1000),
        })
        .execute();
      return id;
    }

    async function double(
      userId: string,
      intentId: string,
    ): Promise<ReturnType<FastifyInstance['inject']>> {
      return app.inject({
        method: 'POST',
        url: '/checkin/double',
        headers: auth(userId),
        payload: { intent_id: intentId },
      });
    }

    it('needs today claimed first', async () => {
      const userId = await createUser(await enabledRegion());
      const res = await double(userId, await checkinIntent(userId));
      expect(res.statusCode).toBe(409);
      expect(res.json<ErrorResponseBody>().error.code).toBe('CHECKIN_NOT_CLAIMED');
    });

    it("pays today's reward again for a verified checkin ad, once per day", async () => {
      const userId = await createUser(await enabledRegion());
      await seedCheckin(userId, 1);
      await app.inject({ method: 'POST', url: '/checkin/claim', headers: auth(userId) });

      const before = await app.inject({
        method: 'GET',
        url: '/checkin/state',
        headers: auth(userId),
      });
      expect(before.json()).toMatchObject({
        streak_day: 2,
        bonus_coin: 15,
        bonus_claimed_today: false,
      });

      const intentId = await checkinIntent(userId);
      const res = await double(userId, intentId);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ credited_coin: 15, new_balance: '30' });

      const intent = await db
        .selectFrom('rewarded_ad_intents')
        .select('checkin_bonus_ledger_id')
        .where('id', '=', intentId)
        .executeTakeFirstOrThrow();
      expect(intent.checkin_bonus_ledger_id).not.toBeNull();

      const replay = await double(userId, intentId);
      expect(replay.statusCode).toBe(403);
      expect(replay.json<ErrorResponseBody>().error.code).toBe('AD_NOT_VERIFIED');

      const second = await double(userId, await checkinIntent(userId));
      expect(second.statusCode).toBe(409);
      expect(second.json<ErrorResponseBody>().error.code).toBe('ALREADY_CLAIMED');

      const after = await app.inject({
        method: 'GET',
        url: '/checkin/state',
        headers: auth(userId),
      });
      expect(after.json()).toMatchObject({ bonus_claimed_today: true });
    });

    it('rejects an unverified or wrong-placement intent', async () => {
      const userId = await createUser(await enabledRegion());
      await app.inject({ method: 'POST', url: '/checkin/claim', headers: auth(userId) });

      const pending = await double(userId, await checkinIntent(userId, { status: 'pending' }));
      expect(pending.statusCode).toBe(403);
      const spinAd = await double(userId, await checkinIntent(userId, { placement: 'luckyspin' }));
      expect(spinAd.statusCode).toBe(403);
      expect(spinAd.json<ErrorResponseBody>().error.code).toBe('AD_NOT_VERIFIED');
    });
  });

  it('treats one Vietnam calendar day as one day even across a UTC date change', async () => {
    const userId = await createUser(await enabledRegion({ timezone: 'Asia/Ho_Chi_Minh' }));
    // Only Date is faked: pg/ioredis timers keep running on the real clock.
    vi.useFakeTimers({ toFake: ['Date'] });

    // 06:30 on 10 Aug in Vietnam — still 9 Aug in UTC.
    vi.setSystemTime(new Date('2026-08-09T23:30:00Z'));
    const morning = await app.inject({
      method: 'POST',
      url: '/checkin/claim',
      headers: auth(userId),
    });
    expect(morning.statusCode).toBe(200);

    // 08:00 the same Vietnam day, now 10 Aug in UTC. A UTC-based day boundary would pay twice.
    vi.setSystemTime(new Date('2026-08-10T01:00:00Z'));
    const later = await app.inject({
      method: 'POST',
      url: '/checkin/claim',
      headers: auth(userId),
    });
    expect(later.statusCode).toBe(409);
    expect(later.json<ErrorResponseBody>().error.code).toBe('ALREADY_CLAIMED');

    const credits = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('user_id', '=', userId)
      .where('entry_type', '=', 'CHECKIN_CREDIT')
      .execute();
    expect(credits).toHaveLength(1);
  });

  it('continues an unbroken streak into today', async () => {
    const userId = await createUser(await enabledRegion());
    await seedCheckin(userId, 3);
    await seedCheckin(userId, 2);
    await seedCheckin(userId, 1);

    const state = await app.inject({
      method: 'GET',
      url: '/checkin/state',
      headers: auth(userId),
    });
    expect(state.json<CheckinStateBody>().streak_day).toBe(4);
    expect(state.json<CheckinStateBody>().days_claimed).toBe(3);

    const claim = await app.inject({
      method: 'POST',
      url: '/checkin/claim',
      headers: auth(userId),
    });
    expect(claim.statusCode).toBe(200);
    const body = claim.json<CheckinClaimBody>();
    expect(body.streak_day).toBe(4);
    expect(body.credited_coin).toBe(25); // rewards[3]
  });

  it('resets the streak after a missed day', async () => {
    const userId = await createUser(await enabledRegion());
    await seedCheckin(userId, 4);
    await seedCheckin(userId, 3);

    const claim = await app.inject({
      method: 'POST',
      url: '/checkin/claim',
      headers: auth(userId),
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json<CheckinClaimBody>().streak_day).toBe(1);
  });

  it('loops the reward table once the streak outruns the configured cycle', async () => {
    const userId = await createUser(await enabledRegion({ rewards: [10, 20] }));
    await seedCheckin(userId, 3);
    await seedCheckin(userId, 2);
    await seedCheckin(userId, 1);

    const claim = await app.inject({
      method: 'POST',
      url: '/checkin/claim',
      headers: auth(userId),
    });
    expect(claim.json<CheckinClaimBody>().streak_day).toBe(2);
    expect(claim.json<CheckinClaimBody>().credited_coin).toBe(20);
  });

  it('returns to day one after completing a seven-day cycle', async () => {
    const userId = await createUser(await enabledRegion());
    for (let daysAgo = 7; daysAgo >= 1; daysAgo -= 1) {
      await seedCheckin(userId, daysAgo);
    }

    const state = await app.inject({
      method: 'GET',
      url: '/checkin/state',
      headers: auth(userId),
    });
    expect(state.json<CheckinStateBody>().streak_day).toBe(1);
    // streak_day cycles back to 1 for the eighth day; days_claimed keeps counting.
    expect(state.json<CheckinStateBody>().days_claimed).toBe(7);
    expect(state.json<CheckinStateBody>().next_reward_coin).toBe(10);

    const claim = await app.inject({
      method: 'POST',
      url: '/checkin/claim',
      headers: auth(userId),
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json<CheckinClaimBody>()).toMatchObject({ streak_day: 1, credited_coin: 10 });
  });

  it('gates check-in claims on the region flag but still answers state', async () => {
    const userId = await createUser(await enabledRegion({ checkinEnabled: false }));

    const claim = await app.inject({
      method: 'POST',
      url: '/checkin/claim',
      headers: auth(userId),
    });
    expect(claim.statusCode).toBe(404);
    expect(claim.json<ErrorResponseBody>().error.code).toBe('FEATURE_DISABLED');

    const state = await app.inject({
      method: 'GET',
      url: '/checkin/state',
      headers: auth(userId),
    });
    expect(state.statusCode).toBe(200);
    expect(state.json<CheckinStateBody>().enabled).toBe(false);
  });

  it('never offers a watch_ad task for manual claim', async () => {
    const regionId = await enabledRegion({
      tasks: {
        enabled: true,
        list: [
          ...DEFAULT_TASKS,
          {
            id: 'watch_ad_1',
            title: 'Watch an Ad',
            description: 'Watch a video',
            reward_coin: 20,
            task_type: 'watch_ad',
          },
        ],
      },
    });
    const userId = await createUser(regionId);

    const list = await app.inject({ method: 'GET', url: '/earning/tasks', headers: auth(userId) });
    expect(list.statusCode).toBe(200);
    const body = list.json<TaskListBody>();
    expect(body.tasks.map((task) => task.id)).toEqual(['daily_login', 'share_app']);
    expect(body.tasks.some((task) => task.task_type === 'watch_ad')).toBe(false);

    // Ad rewards belong to the verified SSV path; claiming one by id must not mint coin.
    const claim = await app.inject({
      method: 'POST',
      url: '/earning/tasks/claim',
      headers: auth(userId),
      payload: { task_id: 'watch_ad_1' },
    });
    expect(claim.statusCode).toBe(404);
    const credits = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(credits).toHaveLength(0);
  });

  it('claims a task once per day and marks it complete', async () => {
    const userId = await createUser(await enabledRegion());

    const claim = await app.inject({
      method: 'POST',
      url: '/earning/tasks/claim',
      headers: auth(userId),
      payload: { task_id: 'share_app' },
    });
    expect(claim.statusCode).toBe(200);
    const body = claim.json<TaskClaimBody>();
    expect(body.credited_coin).toBe(50);
    expect(body.new_balance).toBe('50');

    const again = await app.inject({
      method: 'POST',
      url: '/earning/tasks/claim',
      headers: auth(userId),
      payload: { task_id: 'share_app' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<ErrorResponseBody>().error.code).toBe('ALREADY_CLAIMED');

    const list = await app.inject({ method: 'GET', url: '/earning/tasks', headers: auth(userId) });
    const tasks = list.json<TaskListBody>().tasks;
    expect(tasks.find((task) => task.id === 'share_app')?.completed_today).toBe(true);
    expect(tasks.find((task) => task.id === 'daily_login')?.completed_today).toBe(false);

    // status/progress/target restate completed_today in the shape the Home list renders, so they
    // must never disagree with it.
    expect(tasks.find((task) => task.id === 'share_app')).toMatchObject({
      status: 'completed',
      progress: 1,
      target: 1,
    });
    expect(tasks.find((task) => task.id === 'daily_login')).toMatchObject({
      status: 'available',
      progress: 0,
      target: 1,
    });
  });

  it('exposes icon and action from config, defaulting to null', async () => {
    const regionId = await enabledRegion({
      tasks: {
        enabled: true,
        list: [
          {
            id: 'daily_login',
            title: 'Daily Login',
            description: 'Log in today',
            reward_coin: 10,
            task_type: 'daily_login',
            icon_url: 'https://cdn.example/login.png',
            action: 'ainovel://home',
          },
          // No icon_url/action keys at all — a task seeded before migration 38.
          {
            id: 'share_app',
            title: 'Share',
            description: 'Share the app',
            reward_coin: 50,
            task_type: 'share_app',
          },
        ],
      },
    });
    const userId = await createUser(regionId);

    const list = await app.inject({ method: 'GET', url: '/earning/tasks', headers: auth(userId) });
    const tasks = list.json<TaskListBody>().tasks;
    expect(tasks.find((task) => task.id === 'daily_login')).toMatchObject({
      icon_url: 'https://cdn.example/login.png',
      action: 'ainovel://home',
    });
    // Absent in config must serialize as null, not undefined — the response schema requires the key.
    expect(tasks.find((task) => task.id === 'share_app')).toMatchObject({
      icon_url: null,
      action: null,
    });
  });

  it('rejects an unknown task id without minting coin', async () => {
    const userId = await createUser(await enabledRegion());
    const res = await app.inject({
      method: 'POST',
      url: '/earning/tasks/claim',
      headers: auth(userId),
      payload: { task_id: 'not_a_task' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorResponseBody>().error.code).toBe('NOT_FOUND');

    const credits = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(credits).toHaveLength(0);
  });

  it('fails closed when a region has no tasks config at all', async () => {
    const regionId = await createRegion({ timezone: 'UTC', checkin: { enabled: true } });
    const userId = await createUser(regionId);

    const list = await app.inject({ method: 'GET', url: '/earning/tasks', headers: auth(userId) });
    expect(list.statusCode).toBe(404);
    expect(list.json<ErrorResponseBody>().error.code).toBe('FEATURE_DISABLED');

    const claim = await app.inject({
      method: 'POST',
      url: '/earning/tasks/claim',
      headers: auth(userId),
      payload: { task_id: 'daily_login' },
    });
    expect(claim.statusCode).toBe(404);
    expect(claim.json<ErrorResponseBody>().error.code).toBe('FEATURE_DISABLED');
  });

  it('resolves the tasks region from the account, not the request IP', async () => {
    // The request comes from 127.0.0.1, which geo-resolves to the seeded ROW region where tasks are
    // enabled. The user's own region has them off, and that is the one that must win.
    const regionId = await createRegion({ timezone: 'UTC', tasks: { enabled: false } });
    const userId = await createUser(regionId);

    const res = await app.inject({ method: 'GET', url: '/earning/tasks', headers: auth(userId) });
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorResponseBody>().error.code).toBe('FEATURE_DISABLED');
  });

  it('stops paying once the unbacked rolling cap is reached', async () => {
    const userId = await createUser(await enabledRegion());
    await db
      .insertInto('coin_ledger')
      .values({
        id: uuidv7(),
        user_id: userId,
        entry_type: 'WELCOME_CREDIT',
        amount: 19_990,
        bucket: 'available',
        balance_after: 19_990,
        idempotency_key: `cap-seed:${userId}`,
      })
      .execute();

    const res = await app.inject({
      method: 'POST',
      url: '/earning/tasks/claim',
      headers: auth(userId),
      payload: { task_id: 'share_app' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json<ErrorResponseBody>().error.code).toBe('UNBACKED_CAP_EXCEEDED');
  });

  it('exposes /v1 aliases', async () => {
    const userId = await createUser(await enabledRegion());

    const state = await app.inject({
      method: 'GET',
      url: '/v1/checkin/state',
      headers: auth(userId),
    });
    expect(state.statusCode).toBe(200);

    const tasks = await app.inject({
      method: 'GET',
      url: '/v1/earning/tasks',
      headers: auth(userId),
    });
    expect(tasks.statusCode).toBe(200);

    const claim = await app.inject({
      method: 'POST',
      url: '/v1/checkin/claim',
      headers: auth(userId),
    });
    expect(claim.statusCode).toBe(200);
  });
});
