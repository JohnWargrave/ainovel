import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';

const ADMIN_API_KEY = 'test-admin-api-key';

interface TimeseriesPoint {
  date: string;
  coin_minted: string;
  coin_burned: string;
  new_users: number;
  revenue_usd: number;
}

interface TimeseriesBody {
  from: string;
  to: string;
  region: string | null;
  points: TimeseriesPoint[];
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe('admin analytics timeseries', () => {
  let app: FastifyInstance;
  let analystId: string;
  let regionId: string;
  let otherRegionId: string;
  let userId: string;

  async function createRegion(): Promise<string> {
    const id = `TS_${randomUUID().slice(0, 6)}`;
    await db
      .insertInto('region_config')
      .values({ region_id: id, countries: [], features: { timezone: 'UTC' } })
      .execute();
    return id;
  }

  async function createUser(region: string, createdAt: Date): Promise<string> {
    const id = uuidv7();
    await db
      .insertInto('users')
      .values({
        id,
        auth_provider: 'guest',
        auth_subject: `ts-${randomUUID()}`,
        email: null,
        country_code: 'VN',
        region_id: region,
        status: 'active',
        created_at: createdAt,
      })
      .execute();
    await db.insertInto('wallets').values({ user_id: id, available_coin: 0 }).execute();
    return id;
  }

  async function ledgerEntry(user: string, amount: number, createdAt: Date): Promise<void> {
    await db
      .insertInto('coin_ledger')
      .values({
        id: uuidv7(),
        user_id: user,
        entry_type: amount > 0 ? 'CHECKIN_CREDIT' : 'REDEMPTION_DEBIT',
        amount,
        bucket: 'available',
        balance_after: '0',
        created_at: createdAt,
      })
      .execute();
  }

  function pointFor(body: TimeseriesBody, date: string): TimeseriesPoint {
    const found = body.points.find((point) => point.date === date);
    if (!found) throw new Error(`No bucket for ${date}`);
    return found;
  }

  beforeAll(async () => {
    app = await buildApp();
    analystId = uuidv7();
    await db
      .insertInto('admin_users')
      .values({ id: analystId, email: `ts-${randomUUID()}@test.local`, role: 'analyst' })
      .execute();

    regionId = await createRegion();
    otherRegionId = await createRegion();
    userId = await createUser(regionId, daysAgo(3));

    await ledgerEntry(userId, 500, daysAgo(3));
    await ledgerEntry(userId, 250, daysAgo(3));
    await ledgerEntry(userId, -100, daysAgo(3));

    // A second region's activity, to prove the region filter actually excludes it.
    const otherUser = await createUser(otherRegionId, daysAgo(3));
    await ledgerEntry(otherUser, 9_000, daysAgo(3));
  });

  afterAll(async () => {
    await app.close();
  });

  function headers(id: string): Record<string, string> {
    return { 'x-admin-api-key': ADMIN_API_KEY, 'x-admin-user-id': id };
  }

  async function fetchSeries(query: string): Promise<TimeseriesBody> {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/analytics/timeseries${query}`,
      headers: headers(analystId),
    });
    expect(res.statusCode).toBe(200);
    return res.json<TimeseriesBody>();
  }

  it('returns one dense bucket per day, zero-filled where nothing happened', async () => {
    // Region-scoped on purpose. The suites share a database, so an unscoped query also counts
    // ledger rows other tests wrote — and "this day is zero" is only assertable about a slice this
    // test owns. The density and ordering below hold either way; the zero-fill does not.
    const body = await fetchSeries(`?days=7&region=${regionId}`);

    expect(body.points).toHaveLength(7);
    // Dense and ordered: a gap would draw a line straight across a dead day.
    expect(body.points.map((point) => point.date)).toEqual(
      [...Array(7).keys()].map((offset) => utcDay(daysAgo(6 - offset))),
    );
    expect(body.points[body.points.length - 1]?.date).toBe(utcDay(new Date()));

    const quiet = pointFor(body, utcDay(daysAgo(5)));
    expect(quiet).toMatchObject({
      coin_minted: '0',
      coin_burned: '0',
      new_users: 0,
      revenue_usd: 0,
    });
  });

  it('buckets mint and burn separately on the day they happened', async () => {
    const body = await fetchSeries(`?days=7&region=${regionId}`);
    const active = pointFor(body, utcDay(daysAgo(3)));

    // Signed amounts are split, not netted — 750 minted against 100 burned, never a single 650.
    expect(active.coin_minted).toBe('750');
    expect(active.coin_burned).toBe('100');
    expect(active.new_users).toBe(1);
  });

  it('scopes every measure to the region filter', async () => {
    const scoped = await fetchSeries(`?days=7&region=${regionId}`);
    const unscoped = await fetchSeries('?days=7');

    const day = utcDay(daysAgo(3));
    expect(pointFor(scoped, day).coin_minted).toBe('750');
    // The other region's 9,000 is present without the filter and absent with it.
    expect(Number(pointFor(unscoped, day).coin_minted)).toBeGreaterThanOrEqual(9_750);
    expect(scoped.region).toBe(regionId);
    expect(unscoped.region).toBeNull();
  });

  it('defaults to 30 days and rejects a range outside the allowed bounds', async () => {
    expect((await fetchSeries('')).points).toHaveLength(30);

    for (const query of ['?days=1', '?days=181', '?days=abc']) {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/analytics/timeseries${query}`,
        headers: headers(analystId),
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('is closed to roles without analytics access', async () => {
    const fulfillmentId = uuidv7();
    await db
      .insertInto('admin_users')
      .values({ id: fulfillmentId, email: `ts-${randomUUID()}@test.local`, role: 'fulfillment' })
      .execute();

    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/timeseries?days=7',
      headers: headers(fulfillmentId),
    });
    expect(res.statusCode).toBe(403);
  });
});
