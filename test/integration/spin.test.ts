import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { sql } from 'kysely';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

const PAID_CONFIG_ID = '00000000-0000-7000-8000-000000000021';
const FREE_CONFIG_ID = '00000000-0000-7000-8000-000000000022';

interface ErrorResponseBody {
  error: { code: string; message: string };
}

interface SpinStateResponseBody {
  ticket_coin: string;
  spins_today: number;
  spins_remaining: number;
  daily_cap: number;
  ads_remaining: number;
  next_ad_available_at: string | null;
  free_spin_available: boolean;
  reset_at: string;
  odds_disclosure: string;
  paid_prizes_display: Record<string, unknown>[];
  free_prizes_display: Record<string, unknown>[];
  prizes_display: Record<string, unknown>[];
  active_boost: { multiplier: number; expires_at: string } | null;
}

interface SpinResponseBody {
  prize_slot: number;
  prize_type: string;
  prize_value: string;
  new_balance: string;
  boost?: { multiplier: number; expires_at: string };
}

async function createRegion(regionId: string, spin: Record<string, unknown>): Promise<void> {
  await db
    .insertInto('region_config')
    .values({
      region_id: regionId,
      countries: [],
      features: { spin },
    })
    .execute();
}

async function createTestUser(overrides?: {
  region_id?: string;
  status?: string;
  fraud_score?: number;
  available_coin?: number;
  pending_coin?: number;
}): Promise<string> {
  const userId = uuidv7();
  await db
    .insertInto('users')
    .values({
      id: userId,
      auth_provider: 'guest',
      auth_subject: `test-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: overrides?.region_id ?? 'VN',
      status: overrides?.status ?? 'active',
      fraud_score: overrides?.fraud_score ?? 0,
    })
    .execute();
  await db
    .insertInto('wallets')
    .values({
      user_id: userId,
      available_coin: overrides?.available_coin ?? 1000,
      pending_coin: overrides?.pending_coin ?? 0,
    })
    .execute();
  return userId;
}

// Spins are ad-funded, so every POST /spin needs an intent the SSV callback has already confirmed.
// Inserted directly rather than driven through /postback/admob_ssv — the signature path has its own
// coverage in rewarded-ads.test.ts, and going through it here would test AdMob, not spin.
async function verifiedIntent(
  userId: string,
  overrides?: { status?: string; placement?: string | null; regionId?: string },
): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('rewarded_ad_intents')
    .values({
      id,
      user_id: userId,
      region_id: overrides?.regionId ?? 'VN',
      status: overrides?.status ?? 'consumed',
      placement: overrides?.placement === undefined ? 'luckyspin' : overrides.placement,
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
    })
    .execute();
  return id;
}

async function spin(
  app: FastifyInstance,
  token: string,
  intentId: string,
  url = '/spin',
): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'POST',
    url,
    headers: { ...APP_HEADERS, authorization: `Bearer ${token}` },
    payload: { intent_id: intentId },
  });
}

async function createPityConfig(): Promise<string> {
  const id = uuidv7();
  const prizes = [
    { slot: 1, type: 'coin', value: 10, weight: 100, tier: 'low', label: '10 coin' },
    { slot: 2, type: 'coin', value: 500, weight: 1, tier: 'high', label: '500 coin' },
  ];
  await sql`
    INSERT INTO spin_config (id, name, ticket_coin, max_ev_coin, daily_cap, pity_threshold, prizes)
    VALUES (${id}, ${`Pity test ${randomUUID()}`}, 0, 95, 20, 1, ${JSON.stringify(prizes)}::jsonb)
  `.execute(db);
  return id;
}

async function createBoostConfig(): Promise<string> {
  const id = uuidv7();
  const prizes = [{ slot: 1, type: 'boost', value: '2x60', weight: 1, tier: 'mid' }];
  await sql`
    INSERT INTO spin_config (id, name, ticket_coin, max_ev_coin, daily_cap, pity_threshold, prizes)
    VALUES (${id}, ${`Boost test ${randomUUID()}`}, 0, 95, 20, 0, ${JSON.stringify(prizes)}::jsonb)
  `.execute(db);
  return id;
}

describe('lucky spin', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;

  beforeAll(async () => {
    app = await buildApp();
    accessJwt = (app.jwt as unknown as { access: JWT }).access;
  });

  afterAll(async () => {
    await app.close();
  });

  function tokenFor(userId: string): string {
    return accessJwt.sign({ sub: userId, trust_level: 0 });
  }

  it('returns spin state with public odds only', async () => {
    const userId = await createTestUser();
    const res = await app.inject({
      method: 'GET',
      url: '/spin/state',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<SpinStateResponseBody>();
    // Retained but always zero — spins are paid for by an ad now, not from the wallet.
    expect(body.ticket_coin).toBe('0');
    expect(body.daily_cap).toBe(20);
    expect(body.spins_today).toBe(0);
    expect(body.spins_remaining).toBe(20);
    expect(body.ads_remaining).toBe(20);
    expect(body.free_spin_available).toBe(true);
    expect(Date.parse(body.reset_at)).toBeGreaterThan(Date.now());
    expect(body.odds_disclosure).toContain('base odds');
    expect(body.paid_prizes_display).toHaveLength(8);
    expect(body.free_prizes_display).toHaveLength(8);
    expect(body.prizes_display).toHaveLength(8);
    expect(body.prizes_display[0]).not.toHaveProperty('weight');
    expect(body.prizes_display[0]?.['pct']).toBeTypeOf('number');
  });

  it('requires app headers and auth for state', async () => {
    const userId = await createTestUser();
    const missingHeaders = await app.inject({
      method: 'GET',
      url: '/spin/state',
      headers: { authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(missingHeaders.statusCode).toBe(400);

    const missingAuth = await app.inject({
      method: 'GET',
      url: '/spin/state',
      headers: APP_HEADERS,
    });
    expect(missingAuth.statusCode).toBe(401);
  });

  it('performs a paid spin against a verified ad intent, with history and optional coin credit', async () => {
    const userId = await createTestUser({ available_coin: 1000, pending_coin: 777 });
    const intentId = await verifiedIntent(userId);
    const res = await spin(app, tokenFor(userId), intentId);

    expect(res.statusCode).toBe(200);
    const body = res.json<SpinResponseBody>();
    expect(body.prize_slot).toBeGreaterThanOrEqual(1);
    expect(body.new_balance).toBeTypeOf('string');

    const history = await db
      .selectFrom('spin_history')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(history.mode).toBe('paid');
    expect(history.server_seed_hash).toHaveLength(64);
    expect(history.server_seed).toHaveLength(64);
    expect(
      createHash('sha256')
        .update(Buffer.from(history.server_seed ?? '', 'hex'))
        .digest('hex'),
    ).toBe(history.server_seed_hash);
    const digest = createHash('sha256')
      .update(Buffer.from(history.server_seed ?? '', 'hex'))
      .digest();
    expect(Number(history.roll)).toBeCloseTo(digest.readUIntBE(0, 6) / 2 ** 48, 8);
    expect(Number(history.roll)).toBeGreaterThanOrEqual(0);
    expect(Number(history.roll)).toBeLessThan(1);

    // The whole point of the pivot: the ad paid for this, so nothing is taken from the wallet.
    const debits = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('user_id', '=', userId)
      .where('entry_type', '=', 'SPIN_TICKET_DEBIT')
      .execute();
    expect(debits).toHaveLength(0);

    const spentIntent = await db
      .selectFrom('rewarded_ad_intents')
      .selectAll()
      .where('id', '=', intentId)
      .executeTakeFirstOrThrow();
    expect(spentIntent.spin_history_id).toBe(history.id);

    const wallet = await db
      .selectFrom('wallets')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(wallet.pending_coin).toBe('777');
    expect(wallet.available_coin).toBe(body.new_balance);

    if (body.prize_type === 'coin' && Number(body.prize_value) > 0) {
      const credit = await db
        .selectFrom('coin_ledger')
        .selectAll()
        .where('user_id', '=', userId)
        .where('entry_type', '=', 'SPIN_PRIZE_CREDIT')
        .where('ref_id', '=', history.id)
        .executeTakeFirstOrThrow();
      expect(credit.amount).toBe(body.prize_value);
      expect(credit.note).toBe('paid_spin=true');
    }

    const state = await app.inject({
      method: 'GET',
      url: '/spin/state',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(state.statusCode).toBe(200);
    expect(state.json<SpinStateResponseBody>()).toMatchObject({
      spins_today: 1,
      spins_remaining: 19,
      free_spin_available: true,
    });
  });

  it('spins on an empty wallet — the ad, not the balance, pays for it', async () => {
    const userId = await createTestUser({ available_coin: 0, pending_coin: 0 });
    const res = await spin(app, tokenFor(userId), await verifiedIntent(userId));
    expect(res.statusCode).toBe(200);
  });

  it('rejects a spin with no body', async () => {
    const userId = await createTestUser();
    const res = await app.inject({
      method: 'POST',
      url: '/spin',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorResponseBody>().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an intent the SSV callback has not confirmed yet', async () => {
    const userId = await createTestUser();
    const pending = await verifiedIntent(userId, { status: 'pending' });
    const res = await spin(app, tokenFor(userId), pending);

    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorResponseBody>().error.code).toBe('AD_NOT_VERIFIED');
    // Not burned: the callback may still be in flight, and the app is expected to retry.
    const intent = await db
      .selectFrom('rewarded_ad_intents')
      .selectAll()
      .where('id', '=', pending)
      .executeTakeFirstOrThrow();
    expect(intent.status).toBe('pending');
    expect(intent.spin_history_id).toBeNull();
  });

  it('rejects a replayed intent', async () => {
    const userId = await createTestUser();
    const intentId = await verifiedIntent(userId);

    const first = await spin(app, tokenFor(userId), intentId);
    expect(first.statusCode).toBe(200);

    const second = await spin(app, tokenFor(userId), intentId);
    expect(second.statusCode).toBe(403);
    expect(second.json<ErrorResponseBody>().error.code).toBe('AD_NOT_VERIFIED');

    const history = await db
      .selectFrom('spin_history')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(history).toHaveLength(1);
  });

  it("rejects another user's intent", async () => {
    const owner = await createTestUser();
    const attacker = await createTestUser();
    const intentId = await verifiedIntent(owner);

    const res = await spin(app, tokenFor(attacker), intentId);
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorResponseBody>().error.code).toBe('AD_NOT_VERIFIED');
  });

  it('rejects an intent minted for a different placement', async () => {
    const userId = await createTestUser();
    const intentId = await verifiedIntent(userId, { placement: 'earncoin' });

    const res = await spin(app, tokenFor(userId), intentId);
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorResponseBody>().error.code).toBe('AD_NOT_VERIFIED');
  });

  it('enforces the paid daily cap', async () => {
    const userId = await createTestUser({ available_coin: 5000 });
    for (let i = 0; i < 20; i += 1) {
      await db
        .insertInto('spin_history')
        .values({
          id: uuidv7(),
          user_id: userId,
          spin_config_id: PAID_CONFIG_ID,
          server_seed_hash: `seed-${String(i)}`,
          roll: '0.10000000',
          prize_slot: 1,
          prize_type: 'coin',
          prize_value: '10',
          mode: 'paid',
        })
        .execute();
    }

    const intentId = await verifiedIntent(userId);
    const res = await spin(app, tokenFor(userId), intentId);
    expect(res.statusCode).toBe(429);
    expect(res.json<ErrorResponseBody>().error.code).toBe('DAILY_CAP_REACHED');

    // The cap rejects before the intent is burned, so the user keeps the ad they watched.
    const intent = await db
      .selectFrom('rewarded_ad_intents')
      .selectAll()
      .where('id', '=', intentId)
      .executeTakeFirstOrThrow();
    expect(intent.spin_history_id).toBeNull();
  });

  it('performs one free spin per day without an ad', async () => {
    const userId = await createTestUser({ available_coin: 0 });
    const res = await app.inject({
      method: 'POST',
      url: '/spin/free',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SpinResponseBody>();

    const history = await db
      .selectFrom('spin_history')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(history.mode).toBe('free');
    expect(history.spin_config_id).toBe(FREE_CONFIG_ID);

    const debits = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('user_id', '=', userId)
      .where('entry_type', '=', 'SPIN_TICKET_DEBIT')
      .execute();
    expect(debits).toHaveLength(0);

    if (body.prize_type === 'coin' && Number(body.prize_value) > 0) {
      const credit = await db
        .selectFrom('coin_ledger')
        .selectAll()
        .where('user_id', '=', userId)
        .where('entry_type', '=', 'FREE_SPIN_PRIZE_CREDIT')
        .where('ref_id', '=', history.id)
        .executeTakeFirstOrThrow();
      expect(credit.note).toBe('free_spin=true');
    }

    const state = await app.inject({
      method: 'GET',
      url: '/spin/state',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(state.statusCode).toBe(200);
    expect(state.json<SpinStateResponseBody>()).toMatchObject({
      spins_today: 0,
      spins_remaining: 20,
      free_spin_available: false,
    });

    const second = await app.inject({
      method: 'POST',
      url: '/spin/free',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      payload: {},
    });
    expect(second.statusCode).toBe(429);
    expect(second.json<ErrorResponseBody>().error.code).toBe('FREE_SPIN_ALREADY_CLAIMED');
  });

  it('still accepts and burns an intent on the free spin for older builds', async () => {
    const userId = await createTestUser({ available_coin: 0 });
    const intentId = await verifiedIntent(userId);
    const res = await spin(app, tokenFor(userId), intentId, '/spin/free');
    expect(res.statusCode).toBe(200);

    const intent = await db
      .selectFrom('rewarded_ad_intents')
      .select('spin_history_id')
      .where('id', '=', intentId)
      .executeTakeFirstOrThrow();
    expect(intent.spin_history_id).not.toBeNull();

    const replayUser = await createTestUser({ available_coin: 0 });
    const unverified = await spin(
      app,
      tokenFor(replayUser),
      await verifiedIntent(replayUser, { status: 'pending' }),
      '/spin/free',
    );
    expect(unverified.statusCode).toBe(403);
    expect(unverified.json<ErrorResponseBody>().error.code).toBe('AD_NOT_VERIFIED');
  });

  it('offers the free spin even when the luckyspin ad quota is used up', async () => {
    const userId = await createTestUser();
    for (let i = 0; i < 20; i += 1) {
      await verifiedIntent(userId, { status: 'pending' });
    }
    const state = await app.inject({
      method: 'GET',
      url: '/spin/state',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(state.statusCode).toBe(200);
    expect(state.json<SpinStateResponseBody>()).toMatchObject({
      ads_remaining: 0,
      spins_remaining: 0,
      free_spin_available: true,
    });
  });

  it('counts free-spin coin against the rolling unbacked cap', async () => {
    const userId = await createTestUser({ available_coin: 19_999 });
    await db
      .insertInto('coin_ledger')
      .values({
        id: uuidv7(),
        user_id: userId,
        entry_type: 'CHECKIN_CREDIT',
        amount: 19_999,
        bucket: 'available',
        balance_after: 19_999,
      })
      .execute();

    const res = await spin(app, tokenFor(userId), await verifiedIntent(userId), '/spin/free');
    expect(res.statusCode).toBe(429);
    expect(res.json<ErrorResponseBody>().error.code).toBe('UNBACKED_CAP_EXCEEDED');

    const history = await db
      .selectFrom('spin_history')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(history).toHaveLength(0);
  });

  it('blocks suspended or red-fraud users', async () => {
    const suspendedUser = await createTestUser({ status: 'suspended' });
    const suspended = await spin(app, tokenFor(suspendedUser), await verifiedIntent(suspendedUser));
    expect(suspended.statusCode).toBe(403);
    expect(suspended.json<ErrorResponseBody>().error.code).toBe('SPIN_SUSPENDED');

    const redUser = await createTestUser({ fraud_score: 70 });
    const red = await spin(app, tokenFor(redUser), await verifiedIntent(redUser));
    expect(red.statusCode).toBe(403);
    expect(red.json<ErrorResponseBody>().error.code).toBe('SPIN_SUSPENDED');
  });

  it('gates spin by region feature flag', async () => {
    const regionId = `SPIN_DISABLED_${randomUUID()}`;
    await createRegion(regionId, { enabled: false, table_id: null });
    const userId = await createTestUser({ region_id: regionId });

    const res = await spin(app, tokenFor(userId), await verifiedIntent(userId, { regionId }));
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorResponseBody>().error.code).toBe('FEATURE_DISABLED');
  });

  it('grants a boost prize, queueing a second one behind the first', async () => {
    const configId = await createBoostConfig();
    const regionId = `SPIN_BOOST_${randomUUID()}`;
    await createRegion(regionId, {
      enabled: true,
      table_id: configId,
      free_table_id: FREE_CONFIG_ID,
      timezone: 'UTC',
    });
    const userId = await createTestUser({ region_id: regionId, available_coin: 100 });

    const first = await spin(app, tokenFor(userId), await verifiedIntent(userId, { regionId }));
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<SpinResponseBody>();
    expect(firstBody).toMatchObject({ prize_type: 'boost', prize_value: '2x60', new_balance: '100' });
    const firstEnd = Date.parse(firstBody.boost?.expires_at ?? '');
    expect(firstEnd - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(firstEnd - Date.now()).toBeLessThanOrEqual(60 * 60_000);

    const second = await spin(app, tokenFor(userId), await verifiedIntent(userId, { regionId }));
    expect(second.statusCode).toBe(200);
    const secondEnd = Date.parse(second.json<SpinResponseBody>().boost?.expires_at ?? '');
    expect(secondEnd - firstEnd).toBe(60 * 60_000);

    const state = await app.inject({
      method: 'GET',
      url: '/spin/state',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    // The queued boost has not started, so the active window is still the first one.
    expect(state.json<SpinStateResponseBody>().active_boost).toEqual({
      multiplier: 2,
      expires_at: new Date(firstEnd).toISOString(),
    });

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(me.json<{ active_boost: unknown }>().active_boost).toMatchObject({ multiplier: 2 });

    const ledger = await db
      .selectFrom('coin_ledger')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    expect(ledger).toHaveLength(0);
  });

  it('records pity_applied after the configured low-streak threshold', async () => {
    const configId = await createPityConfig();
    const regionId = `SPIN_PITY_${randomUUID()}`;
    await createRegion(regionId, {
      enabled: true,
      table_id: configId,
      free_table_id: FREE_CONFIG_ID,
      timezone: 'UTC',
    });
    const userId = await createTestUser({ region_id: regionId, available_coin: 1000 });
    await db
      .insertInto('spin_history')
      .values({
        id: uuidv7(),
        user_id: userId,
        spin_config_id: configId,
        server_seed_hash: 'previous-low-seed',
        roll: '0.10000000',
        prize_slot: 1,
        prize_type: 'coin',
        prize_value: '10',
        mode: 'paid',
      })
      .execute();

    const res = await spin(app, tokenFor(userId), await verifiedIntent(userId, { regionId }));
    expect(res.statusCode).toBe(200);

    const latest = await db
      .selectFrom('spin_history')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(latest.pity_applied).toBe(true);
  });

  it('exposes /v1 aliases', async () => {
    const userId = await createTestUser({ available_coin: 1000 });
    const state = await app.inject({
      method: 'GET',
      url: '/v1/spin/state',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(state.statusCode).toBe(200);

    const spun = await spin(app, tokenFor(userId), await verifiedIntent(userId), '/v1/spin');
    expect(spun.statusCode).toBe(200);
  });
});
