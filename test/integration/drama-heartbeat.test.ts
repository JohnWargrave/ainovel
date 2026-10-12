import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { getConfig, invalidateConfigCache } from '../../src/modules/config/config.service.js';

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

const START = '2026-08-19T10:00:00Z';

interface ErrorResponseBody {
  error: { code: string; message: string };
}

interface HeartbeatBody {
  watched_seconds: number;
  required_seconds: number;
  duration_seconds: number;
  rewarded: boolean;
  credited_coin: number;
  new_balance: string;
  daily_remaining: number;
}

interface DramaOverrides {
  enabled?: boolean;
  episode_reward_coin?: number;
  completion_ratio?: number;
  episode_reward_daily_cap?: number;
}

async function createRegion(drama: DramaOverrides = {}): Promise<string> {
  const regionId = `D_${randomUUID().slice(0, 8)}`;
  await db
    .insertInto('region_config')
    .values({
      region_id: regionId,
      countries: [],
      features: {
        timezone: 'UTC',
        drama: {
          enabled: true,
          episode_reward_coin: 12,
          completion_ratio: 0.8,
          episode_reward_daily_cap: 20,
          ...drama,
        },
      },
    })
    .execute();
  return regionId;
}

async function createUser(regionId: string, status = 'active'): Promise<string> {
  const userId = uuidv7();
  await db
    .insertInto('users')
    .values({
      id: userId,
      auth_provider: 'guest',
      auth_subject: `drama-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: regionId,
      status,
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId, available_coin: 0 }).execute();
  return userId;
}

async function ledgerRows(userId: string): Promise<{ entry_type: string; amount: string }[]> {
  return db
    .selectFrom('coin_ledger')
    .select(['entry_type', 'amount'])
    .where('user_id', '=', userId)
    .where('entry_type', '=', 'DRAMA_WATCH_CREDIT')
    .execute();
}

describe('drama watch heartbeat', () => {
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

  async function beat(
    userId: string,
    elapsed: number,
    duration = 100,
    episode = 0,
    dramaId = 'series-a',
  ): Promise<HeartbeatBody> {
    const res = await app.inject({
      method: 'POST',
      url: '/drama/watch-heartbeat',
      headers: headers(userId),
      payload: {
        drama_id: dramaId,
        episode_index: episode,
        elapsed_seconds: elapsed,
        duration_seconds: duration,
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json<HeartbeatBody>();
  }

  // Only Date is faked; the DB and Redis clients still need real timers to resolve.
  function at(iso: string): void {
    vi.setSystemTime(new Date(iso));
  }

  it('credits once when real time backs the reported progress', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(START);
    const userId = await createUser(await createRegion());

    const first = await beat(userId, 0);
    expect(first).toMatchObject({ watched_seconds: 0, required_seconds: 80, rewarded: false });

    at('2026-08-19T10:01:30Z'); // 90s later, and the player advanced 90s
    const second = await beat(userId, 90);

    expect(second.rewarded).toBe(true);
    expect(second.credited_coin).toBe(12);
    expect(second.new_balance).toBe('12');
    expect(second.daily_remaining).toBe(19);
    expect(await ledgerRows(userId)).toEqual([{ entry_type: 'DRAMA_WATCH_CREDIT', amount: '12' }]);
  });

  // The test that matters most: the whole anti-cheat is min(clientDelta, serverDelta), and this is
  // the case it exists for.
  it('gives a seek to 80% only the wall-clock time that actually passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(START);
    const userId = await createUser(await createRegion());

    await beat(userId, 0);
    at('2026-08-19T10:00:01Z'); // one second later
    const seeked = await beat(userId, 9999); // ...and the client claims it finished

    expect(seeked.rewarded).toBe(false);
    expect(seeked.watched_seconds).toBeLessThanOrEqual(2);
    expect(await ledgerRows(userId)).toEqual([]);
  });

  it('caps one heartbeat so a backgrounded app cannot bank the whole gap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(START);
    const userId = await createUser(await createRegion());

    await beat(userId, 0, 7200);
    at('2026-08-19T11:00:00Z'); // an hour of real time, and an hour of claimed playback
    const resumed = await beat(userId, 3600, 7200);

    expect(resumed.watched_seconds).toBe(120); // MAX_GAIN_PER_BEAT_S
    expect(resumed.rewarded).toBe(false);
  });

  it('does not accrue or lose watch time on a rewind', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(START);
    const userId = await createUser(await createRegion());

    await beat(userId, 50);
    at('2026-08-19T10:00:05Z');
    const rewound = await beat(userId, 10);

    expect(rewound.watched_seconds).toBe(0);
    expect(rewound.rewarded).toBe(false);
  });

  it('credits an episode exactly once no matter how long the player keeps beating', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(START);
    const userId = await createUser(await createRegion());

    await beat(userId, 0);
    at('2026-08-19T10:01:30Z');
    expect((await beat(userId, 90)).rewarded).toBe(true);

    at('2026-08-19T10:01:35Z');
    const after = await beat(userId, 95);
    expect(after.rewarded).toBe(false);
    expect(after.credited_coin).toBe(0);
    expect(await ledgerRows(userId)).toHaveLength(1);
  });

  it('pins duration at the first heartbeat so a later body cannot lower the bar', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(START);
    const userId = await createUser(await createRegion());

    expect((await beat(userId, 0, 100)).required_seconds).toBe(80);

    at('2026-08-19T10:00:05Z');
    const shrunk = await beat(userId, 5, 10); // "actually it was a 10s episode"
    expect(shrunk.required_seconds).toBe(80);
    expect(shrunk.rewarded).toBe(false);
  });

  // A 200 rather than a 4xx: this fires every few seconds under a playing video, so a cap has to
  // read as "no reward" and not as a broken player.
  it('stops rewarding at the daily cap without failing the request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(START);
    const userId = await createUser(await createRegion({ episode_reward_daily_cap: 1 }));

    await beat(userId, 0, 100, 0);
    at('2026-08-19T10:01:30Z');
    expect((await beat(userId, 90, 100, 0)).rewarded).toBe(true);

    await beat(userId, 0, 100, 1);
    at('2026-08-19T10:03:00Z');
    const second = await beat(userId, 90, 100, 1);

    expect(second.rewarded).toBe(false);
    expect(second.daily_remaining).toBe(0);
    expect(await ledgerRows(userId)).toHaveLength(1);
  });

  it('is subject to the rolling unbacked cap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(START);
    const userId = await createUser(await createRegion({ episode_reward_coin: 20_000 }));

    await beat(userId, 0, 100, 0);
    at('2026-08-19T10:01:30Z');
    expect((await beat(userId, 90, 100, 0)).rewarded).toBe(true);

    await beat(userId, 0, 100, 1);
    at('2026-08-19T10:03:00Z');
    const res = await app.inject({
      method: 'POST',
      url: '/drama/watch-heartbeat',
      headers: headers(userId),
      payload: {
        drama_id: 'series-a',
        episode_index: 1,
        elapsed_seconds: 90,
        duration_seconds: 100,
      },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json<ErrorResponseBody>().error.code).toBe('UNBACKED_CAP_EXCEEDED');
  });

  it('refuses a banned account', async () => {
    const userId = await createUser(await createRegion(), 'banned');

    const res = await app.inject({
      method: 'POST',
      url: '/drama/watch-heartbeat',
      headers: headers(userId),
      payload: {
        drama_id: 'series-a',
        episode_index: 0,
        elapsed_seconds: 0,
        duration_seconds: 100,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorResponseBody>().error.code).toBe('EARNING_BLOCKED');
  });

  it('tracks progress but never credits while the region has drama disabled', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(START);
    const userId = await createUser(await createRegion({ enabled: false }));

    await beat(userId, 0);
    at('2026-08-19T10:01:30Z');
    const done = await beat(userId, 90);

    expect(done.watched_seconds).toBe(90);
    expect(done.rewarded).toBe(false);
    expect(await ledgerRows(userId)).toEqual([]);
  });

  it('ships the reward parameters to the app through /config', async () => {
    const regionId = await createRegion({ episode_reward_coin: 25, completion_ratio: 0.5 });
    await invalidateConfigCache();

    const { payload } = await getConfig(regionId);

    expect(payload.features.drama).toEqual({
      enabled: true,
      episode_reward_coin: 25,
      completion_ratio: 0.5,
      episode_reward_daily_cap: 20,
    });
  });
});
