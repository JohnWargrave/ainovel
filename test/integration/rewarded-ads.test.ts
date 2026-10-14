import { generateKeyPairSync, sign as cryptoSign, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { Queue } from 'bullmq';
import { sql } from 'kysely';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { queueRedis } from '../../src/redis/index.js';
import { QUEUE_NAME as FRAUD_HOOK_QUEUE_NAME } from '../../src/jobs/postback-fraud-hook.js';
import {
  createVerifierKeyStore,
  type VerifierKey,
  type VerifierKeyFetcher,
} from '../../src/modules/rewarded-ads/admob-verify.js';

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

interface ErrorResponseBody {
  error: { code: string; message: string };
}

interface RewardedAdStateBody {
  enabled: boolean;
  daily_cap: number;
  rewards_today: number;
  pending_rewards: number;
  rewards_remaining: number;
  cooldown_s: number;
  next_available_at: string | null;
  reset_at: string;
}

interface IntentResponseBody {
  intent_id: string;
  ssv_custom_data: string;
  state: RewardedAdStateBody;
}

const KEY_ID = 1;
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const OTHER_KEY_PAIR = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

async function createTestUser(overrides?: {
  region_id?: string;
  status?: string;
}): Promise<string> {
  const { uuidv7 } = await import('uuidv7');
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
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId }).execute();
  return userId;
}

// Must match production's encoding exactly, or this suite validates nothing: signing with the same
// wrong encoding the verifier used is precisely how the ieee-p1363 bug stayed green while every real
// AdMob callback would have failed. DER is what Google actually sends.
function signContent(content: string, key = privateKey): string {
  const signature = cryptoSign('sha256', Buffer.from(content), {
    key,
    dsaEncoding: 'der',
  });
  return signature.toString('base64url');
}

function buildSsvUrl(params: Record<string, string>, key = privateKey): string {
  const content = new URLSearchParams(params).toString();
  const signature = signContent(content, key);
  return `/postback/admob_ssv?${content}&signature=${encodeURIComponent(signature)}`;
}

async function setEcpm(regionId: string, value: number): Promise<void> {
  await sql`
    UPDATE region_config
    SET features = jsonb_set(features, '{rewarded_ads,est_ecpm_usd}', ${JSON.stringify(value)}::jsonb)
    WHERE region_id = ${regionId}
  `.execute(db);
}

async function setRewardedAdsEnabled(regionId: string, enabled: boolean): Promise<void> {
  await sql`
    UPDATE region_config
    SET features = jsonb_set(features, '{rewarded_ads,enabled}', ${JSON.stringify(enabled)}::jsonb)
    WHERE region_id = ${regionId}
  `.execute(db);
}

describe('rewarded video SSV (AdMob)', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;
  let originalVnEcpm: number;
  let originalRowEcpm: number;

  beforeAll(async () => {
    const fetcher = {
      fetch: (): Promise<VerifierKey[]> => Promise.resolve([{ keyId: KEY_ID, pem: publicKeyPem }]),
    };
    app = await buildApp({ verifierKeyStore: createVerifierKeyStore(fetcher) });
    accessJwt = (app.jwt as unknown as { access: JWT }).access;

    const vn = await db
      .selectFrom('region_config')
      .select('features')
      .where('region_id', '=', 'VN')
      .executeTakeFirstOrThrow();
    const rowRegion = await db
      .selectFrom('region_config')
      .select('features')
      .where('region_id', '=', 'ROW')
      .executeTakeFirstOrThrow();
    originalVnEcpm = (vn.features as { rewarded_ads: { est_ecpm_usd: number } }).rewarded_ads
      .est_ecpm_usd;
    originalRowEcpm = (rowRegion.features as { rewarded_ads: { est_ecpm_usd: number } })
      .rewarded_ads.est_ecpm_usd;
  });

  afterAll(async () => {
    await setEcpm('VN', originalVnEcpm);
    await setEcpm('ROW', originalRowEcpm);
    await app.close();
  });

  function tokenFor(userId: string): string {
    return accessJwt.sign({ sub: userId, trust_level: 0 });
  }

  it('creates an intent for an active user in an enabled region', async () => {
    const userId = await createTestUser();
    const res = await app.inject({
      method: 'POST',
      url: '/earning/rewarded-ad/intent',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<IntentResponseBody>();
    expect(body.intent_id).toBe(body.ssv_custom_data);

    const row = await db
      .selectFrom('rewarded_ad_intents')
      .selectAll()
      .where('id', '=', body.intent_id)
      .executeTakeFirstOrThrow();
    expect(row.user_id).toBe(userId);
    expect(row.status).toBe('pending');
    const ttlMs = new Date(row.expires_at).getTime() - new Date(row.created_at).getTime();
    expect(ttlMs).toBeGreaterThan(10 * 60 * 1000 - 1000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('rejects intent creation for a suspended user (EARNING_SUSPENDED)', async () => {
    const userId = await createTestUser({ status: 'suspended' });
    const res = await app.inject({
      method: 'POST',
      url: '/earning/rewarded-ad/intent',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorResponseBody>().error.code).toBe('EARNING_SUSPENDED');
  });

  it('rejects intent creation for a banned user (EARNING_BLOCKED)', async () => {
    const userId = await createTestUser({ status: 'banned' });
    const res = await app.inject({
      method: 'POST',
      url: '/earning/rewarded-ad/intent',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorResponseBody>().error.code).toBe('EARNING_BLOCKED');
  });

  it('rejects intent creation when the region has rewarded ads disabled (FEATURE_DISABLED)', async () => {
    const userId = await createTestUser();
    await setRewardedAdsEnabled('VN', false);

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/earning/rewarded-ad/intent',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<ErrorResponseBody>().error.code).toBe('FEATURE_DISABLED');
    } finally {
      await setRewardedAdsEnabled('VN', true);
    }
  });

  it('rejects a second intent within the cooldown window (COOLDOWN_ACTIVE)', async () => {
    const userId = await createTestUser();
    const first = await app.inject({
      method: 'POST',
      url: '/earning/rewarded-ad/intent',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/earning/rewarded-ad/intent',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json<ErrorResponseBody>().error.code).toBe('COOLDOWN_ACTIVE');
  });

  it('rejects intent creation once the daily cap is reached (DAILY_CAP_REACHED)', async () => {
    const userId = await createTestUser();
    for (let i = 0; i < 20; i++) {
      await db
        .insertInto('earning_events')
        .values({
          id: (await import('uuidv7')).uuidv7(),
          user_id: userId,
          source: 'admob_ssv',
          network_tx_id: `cap-test-${randomUUID()}`,
          coin_awarded: 5,
        })
        .execute();
    }

    const res = await app.inject({
      method: 'POST',
      url: '/earning/rewarded-ad/intent',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json<ErrorResponseBody>().error.code).toBe('DAILY_CAP_REACHED');
  });

  it('credits an available-bucket reward on a valid SSV callback and marks the intent consumed', async () => {
    const userId = await createTestUser();
    const intentRes = await app.inject({
      method: 'POST',
      url: '/earning/rewarded-ad/intent',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    const { intent_id: intentId } = intentRes.json<IntentResponseBody>();

    const walletBefore = await db
      .selectFrom('wallets')
      .select(['available_coin', 'pending_coin'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    const txId = `tx-${randomUUID()}`;
    const url = buildSsvUrl({
      ad_network: '5450213213286189855',
      ad_unit: 'test-unit',
      custom_data: intentId,
      key_id: String(KEY_ID),
      reward_amount: '1',
      reward_item: 'coin',
      timestamp: String(Date.now()),
      transaction_id: txId,
      user_id: userId,
    });

    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);

    const intent = await db
      .selectFrom('rewarded_ad_intents')
      .selectAll()
      .where('id', '=', intentId)
      .executeTakeFirstOrThrow();
    expect(intent.status).toBe('consumed');
    expect(intent.earning_event_id).not.toBeNull();

    const event = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('source', '=', 'admob_ssv')
      .where('network_tx_id', '=', txId)
      .executeTakeFirstOrThrow();
    expect(event.user_id).toBe(userId);
    expect(Number(event.coin_awarded)).toBe(
      intent.coin_awarded ? Number(intent.coin_awarded) : NaN,
    );

    const walletAfter = await db
      .selectFrom('wallets')
      .select(['available_coin', 'pending_coin'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(Number(walletAfter.available_coin) - Number(walletBefore.available_coin)).toBe(
      Number(event.coin_awarded),
    );
    expect(walletAfter.pending_coin).toBe(walletBefore.pending_coin);

    const log = await db
      .selectFrom('postback_logs')
      .selectAll()
      .where('network', '=', 'admob_ssv')
      .where('earning_event_id', '=', event.id)
      .executeTakeFirstOrThrow();
    expect(log.verdict).toBe('accepted');

    // 05-FRAUD-ENGINE.md §1: every credited earning event enqueues the async fraud checkpoint,
    // not just postback-network ones — verified against the real queue (no worker runs in tests).
    const fraudHookQueue = new Queue(FRAUD_HOOK_QUEUE_NAME, { connection: queueRedis });
    try {
      const waiting = await fraudHookQueue.getJobs(['waiting', 'completed']);
      const job = waiting.find((j: { data: { userId?: string } }) => j.data.userId === userId);
      expect(job).toBeDefined();
      expect(job?.data).toMatchObject({ userId, network: 'admob_ssv' });
    } finally {
      await fraudHookQueue.close();
    }
  });

  it('does not double-credit a duplicate SSV callback for an already-consumed intent', async () => {
    const userId = await createTestUser();
    const intentRes = await app.inject({
      method: 'POST',
      url: '/earning/rewarded-ad/intent',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    const { intent_id: intentId } = intentRes.json<IntentResponseBody>();

    const txId = `dup-${randomUUID()}`;
    const params = {
      custom_data: intentId,
      key_id: String(KEY_ID),
      transaction_id: txId,
    };
    const url = buildSsvUrl(params);

    const first = await app.inject({ method: 'GET', url });
    expect(first.statusCode).toBe(200);

    const walletAfterFirst = await db
      .selectFrom('wallets')
      .select('available_coin')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    const second = await app.inject({ method: 'GET', url });
    expect(second.statusCode).toBe(200);

    const walletAfterSecond = await db
      .selectFrom('wallets')
      .select('available_coin')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(walletAfterSecond.available_coin).toBe(walletAfterFirst.available_coin);

    const events = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('source', '=', 'admob_ssv')
      .where('network_tx_id', '=', txId)
      .execute();
    expect(events).toHaveLength(1);
  });

  it('refuses to credit when the callback user_id disagrees with the intent owner', async () => {
    const ownerId = await createTestUser();
    const strangerId = await createTestUser();
    const intentRes = await app.inject({
      method: 'POST',
      url: '/earning/rewarded-ad/intent',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(ownerId)}` },
    });
    const { intent_id: intentId } = intentRes.json<IntentResponseBody>();

    const txId = `mismatch-${randomUUID()}`;
    const res = await app.inject({
      method: 'GET',
      url: buildSsvUrl({
        custom_data: intentId,
        key_id: String(KEY_ID),
        transaction_id: txId,
        user_id: strangerId,
      }),
    });
    // 200 so Google stops retrying — but nothing is credited to either account.
    expect(res.statusCode).toBe(200);

    const intent = await db
      .selectFrom('rewarded_ad_intents')
      .selectAll()
      .where('id', '=', intentId)
      .executeTakeFirstOrThrow();
    expect(intent.status).toBe('pending');
    expect(intent.earning_event_id).toBeNull();

    const events = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('source', '=', 'admob_ssv')
      .where('network_tx_id', '=', txId)
      .execute();
    expect(events).toHaveLength(0);

    const log = await db
      .selectFrom('postback_logs')
      .selectAll()
      .where('network', '=', 'admob_ssv')
      .where(sql<boolean>`query_params->>'transaction_id' = ${txId}`)
      .executeTakeFirstOrThrow();
    expect(log.verdict).toBe('user_not_found');
  });

  it('copies the client context captured at intent time onto the earning event', async () => {
    const userId = await createTestUser();
    const intentRes = await app.inject({
      method: 'POST',
      url: '/earning/rewarded-ad/intent',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    const { intent_id: intentId } = intentRes.json<IntentResponseBody>();

    const intent = await db
      .selectFrom('rewarded_ad_intents')
      .selectAll()
      .where('id', '=', intentId)
      .executeTakeFirstOrThrow();
    // The app's own IP, not Google's — the SSV callback is server-to-server.
    expect(intent.ip_at_intent).not.toBeNull();
    expect(intent.geo_at_intent).toBe('VN');

    const txId = `ctx-${randomUUID()}`;
    await app.inject({
      method: 'GET',
      url: buildSsvUrl({
        custom_data: intentId,
        key_id: String(KEY_ID),
        transaction_id: txId,
      }),
    });

    const event = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('source', '=', 'admob_ssv')
      .where('network_tx_id', '=', txId)
      .executeTakeFirstOrThrow();
    expect(event.ip_at_event).toBe(intent.ip_at_intent);
    expect(event.geo_at_event).toBe('VN');
  });

  it('rejects an SSV callback signed with a different key (bad_signature, 403)', async () => {
    const userId = await createTestUser();
    const intentRes = await app.inject({
      method: 'POST',
      url: '/earning/rewarded-ad/intent',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    const { intent_id: intentId } = intentRes.json<IntentResponseBody>();

    const url = buildSsvUrl(
      {
        custom_data: intentId,
        key_id: String(KEY_ID),
        transaction_id: `bad-sig-${randomUUID()}`,
      },
      OTHER_KEY_PAIR.privateKey,
    );

    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(403);

    const log = await db
      .selectFrom('postback_logs')
      .selectAll()
      .where('network', '=', 'admob_ssv')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(log.verdict).toBe('bad_signature');
  });

  it('accepts (200) but does not credit when custom_data does not match any intent', async () => {
    const txId = `unknown-${randomUUID()}`;
    const url = buildSsvUrl({
      custom_data: randomUUID(),
      key_id: String(KEY_ID),
      transaction_id: txId,
    });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);

    const events = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('network_tx_id', '=', txId)
      .execute();
    expect(events).toHaveLength(0);
  });

  // Regression: this 403'd, which failed the "Verify URL" check in the AdMob console outright —
  // custom_data and user_id are optional fields there and are normally left blank.
  it('accepts (200) a validly signed callback that carries no custom_data', async () => {
    const url = buildSsvUrl({
      ad_network: '5450213213286189855',
      ad_unit: '1234',
      reward_amount: '1',
      reward_item: 'coin',
      timestamp: String(Date.now()),
      transaction_id: `verify-${randomUUID()}`,
      key_id: String(KEY_ID),
    });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
  });

  it('still rejects (403) a callback with no signature at all', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/postback/admob_ssv?custom_data=${randomUUID()}&key_id=${String(KEY_ID)}&transaction_id=${randomUUID()}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts (200) but does not credit an expired intent', async () => {
    const userId = await createTestUser();
    const { uuidv7 } = await import('uuidv7');
    const intentId = uuidv7();
    await db
      .insertInto('rewarded_ad_intents')
      .values({
        id: intentId,
        user_id: userId,
        region_id: 'VN',
        expires_at: new Date(Date.now() - 60_000),
      })
      .execute();

    const url = buildSsvUrl({
      custom_data: intentId,
      key_id: String(KEY_ID),
      transaction_id: `expired-${randomUUID()}`,
    });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);

    const intent = await db
      .selectFrom('rewarded_ad_intents')
      .selectAll()
      .where('id', '=', intentId)
      .executeTakeFirstOrThrow();
    expect(intent.status).toBe('expired');
  });

  it('floors the coin award at 5 for a very small eCPM', async () => {
    const userId = await createTestUser();
    const intentRes = await app.inject({
      method: 'POST',
      url: '/earning/rewarded-ad/intent',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    const { intent_id: intentId } = intentRes.json<IntentResponseBody>();

    await setEcpm('VN', 0.001);
    try {
      const url = buildSsvUrl({
        custom_data: intentId,
        key_id: String(KEY_ID),
        transaction_id: `tiny-${randomUUID()}`,
      });
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
    } finally {
      await setEcpm('VN', originalVnEcpm);
    }

    const intent = await db
      .selectFrom('rewarded_ad_intents')
      .select('coin_awarded')
      .where('id', '=', intentId)
      .executeTakeFirstOrThrow();
    expect(Number(intent.coin_awarded)).toBe(5);
  });

  it('caps the coin award at coin_cap for a very large eCPM', async () => {
    const userId = await createTestUser();
    const intentRes = await app.inject({
      method: 'POST',
      url: '/earning/rewarded-ad/intent',
      headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
    });
    const { intent_id: intentId } = intentRes.json<IntentResponseBody>();

    await setEcpm('VN', 100000);
    try {
      const url = buildSsvUrl({
        custom_data: intentId,
        key_id: String(KEY_ID),
        transaction_id: `huge-${randomUUID()}`,
      });
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
    } finally {
      await setEcpm('VN', originalVnEcpm);
    }

    const intent = await db
      .selectFrom('rewarded_ad_intents')
      .select('coin_awarded')
      .where('id', '=', intentId)
      .executeTakeFirstOrThrow();
    expect(Number(intent.coin_awarded)).toBe(50);
  });

  describe('GET /earning/rewarded-ad/state', () => {
    // A region of its own: daily_cap and cooldown_s have to move for these cases, and VN/ROW are
    // asserted verbatim by config.test.ts while suites run in parallel.
    async function createStateRegion(overrides?: {
      daily_cap?: number;
      cooldown_s?: number;
      enabled?: boolean;
      timezone?: string;
    }): Promise<string> {
      const regionId = `RA_${randomUUID().slice(0, 8)}`;
      await db
        .insertInto('region_config')
        .values({
          region_id: regionId,
          countries: [],
          features: {
            timezone: overrides?.timezone ?? 'Asia/Ho_Chi_Minh',
            rewarded_ads: {
              enabled: overrides?.enabled ?? true,
              daily_cap: overrides?.daily_cap ?? 20,
              coin_cap: 50,
              cooldown_s: overrides?.cooldown_s ?? 0,
              est_ecpm_usd: 2.5,
            },
          },
        })
        .execute();
      return regionId;
    }

    function stateRequest(userId: string, prefix = ''): Promise<LightMyRequestResponse> {
      return app.inject({
        method: 'GET',
        url: `${prefix}/earning/rewarded-ad/state`,
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
    }

    it('reports the cap, usage, and the region-local reset instant', async () => {
      const regionId = await createStateRegion({ daily_cap: 7, cooldown_s: 30 });
      const userId = await createTestUser({ region_id: regionId });

      const res = await stateRequest(userId);
      expect(res.statusCode).toBe(200);
      const body = res.json<RewardedAdStateBody>();
      expect(body).toMatchObject({
        enabled: true,
        daily_cap: 7,
        rewards_today: 0,
        pending_rewards: 0,
        rewards_remaining: 7,
        cooldown_s: 30,
        next_available_at: null,
      });
      // Midnight in Asia/Ho_Chi_Minh (UTC+7) is 17:00:00Z the day before.
      const resetAt = new Date(body.reset_at);
      expect(resetAt.getUTCHours()).toBe(17);
      expect(resetAt.getUTCMinutes()).toBe(0);
      expect(resetAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('reports enabled:false instead of erroring when the region has the feature off', async () => {
      const regionId = await createStateRegion({ enabled: false });
      const userId = await createTestUser({ region_id: regionId });

      const res = await app.inject({
        method: 'GET',
        url: '/earning/rewarded-ad/state',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<RewardedAdStateBody>().enabled).toBe(false);
    });

    it('counts a fresh intent as a held slot and returns the post-reservation state', async () => {
      const regionId = await createStateRegion({ daily_cap: 5, cooldown_s: 30 });
      const userId = await createTestUser({ region_id: regionId });

      const intent = await app.inject({
        method: 'POST',
        url: '/earning/rewarded-ad/intent',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(intent.statusCode).toBe(200);
      const intentState = intent.json<IntentResponseBody>().state;
      expect(intentState).toMatchObject({
        daily_cap: 5,
        rewards_today: 0,
        pending_rewards: 1,
        rewards_remaining: 4,
      });
      expect(intentState.next_available_at).not.toBeNull();

      const state = await app.inject({
        method: 'GET',
        url: '/earning/rewarded-ad/state',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(state.json<RewardedAdStateBody>()).toMatchObject({
        rewards_today: 0,
        pending_rewards: 1,
        rewards_remaining: 4,
      });
    });

    it('releases a pending slot held by an intent created before the current region day', async () => {
      const regionId = await createStateRegion({ daily_cap: 1 });
      const userId = await createTestUser({ region_id: regionId });
      const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
      await db
        .insertInto('rewarded_ad_intents')
        .values({
          id: (await import('uuidv7')).uuidv7(),
          user_id: userId,
          region_id: regionId,
          status: 'pending',
          created_at: yesterday,
          // Still unexpired, so only the day window can stop it from holding today's only slot.
          expires_at: new Date(Date.now() + 10 * 60 * 1000),
        })
        .execute();

      const res = await app.inject({
        method: 'GET',
        url: '/earning/rewarded-ad/state',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(res.json<RewardedAdStateBody>()).toMatchObject({
        pending_rewards: 0,
        rewards_remaining: 1,
      });
    });

    it('does not let two concurrent intents both consume the last slot', async () => {
      const regionId = await createStateRegion({ daily_cap: 1, cooldown_s: 0 });
      const userId = await createTestUser({ region_id: regionId });
      const headers = { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` };

      const [first, second] = await Promise.all([
        app.inject({ method: 'POST', url: '/earning/rewarded-ad/intent', headers }),
        app.inject({ method: 'POST', url: '/earning/rewarded-ad/intent', headers }),
      ]);

      const codes = [first.statusCode, second.statusCode].sort();
      expect(codes).toEqual([200, 429]);
      const rejected = first.statusCode === 429 ? first : second;
      expect(rejected.json<ErrorResponseBody>().error.code).toBe('DAILY_CAP_REACHED');

      const pending = await db
        .selectFrom('rewarded_ad_intents')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(Number(pending.count)).toBe(1);
    });

    it('requires a bearer token and answers on the /v1 alias', async () => {
      const regionId = await createStateRegion();
      const userId = await createTestUser({ region_id: regionId });

      const anonymous = await app.inject({
        method: 'GET',
        url: '/earning/rewarded-ad/state',
        headers: APP_HEADERS,
      });
      expect(anonymous.statusCode).toBe(401);

      const versioned = await stateRequest(userId, '/v1');
      expect(versioned.statusCode).toBe(200);
    });
  });

  describe('placements', () => {
    async function createPlacementRegion(
      placements: Record<string, Record<string, number>>,
    ): Promise<string> {
      const regionId = `RAP_${randomUUID().slice(0, 8)}`;
      await db
        .insertInto('region_config')
        .values({
          region_id: regionId,
          countries: [],
          features: {
            timezone: 'Asia/Ho_Chi_Minh',
            rewarded_ads: {
              enabled: true,
              daily_cap: 20,
              coin_cap: 50,
              cooldown_s: 0,
              est_ecpm_usd: 2.5,
              placements,
            },
          },
        })
        .execute();
      return regionId;
    }

    function intentRequest(userId: string, placement?: string): Promise<LightMyRequestResponse> {
      return app.inject({
        method: 'POST',
        url: '/earning/rewarded-ad/intent',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
        payload: placement ? { placement } : {},
      });
    }

    it('gives each placement its own quota', async () => {
      const regionId = await createPlacementRegion({
        earncoin: { daily_cap: 1, cooldown_s: 0, coin_multiplier: 1 },
        luckyspin: { daily_cap: 5, cooldown_s: 0, coin_multiplier: 1 },
      });
      const userId = await createTestUser({ region_id: regionId });

      expect((await intentRequest(userId, 'earncoin')).statusCode).toBe(200);
      // earncoin's cap of 1 is now held by that pending intent...
      const exhausted = await intentRequest(userId, 'earncoin');
      expect(exhausted.statusCode).toBe(429);
      expect(exhausted.json<ErrorResponseBody>().error.code).toBe('DAILY_CAP_REACHED');

      // ...while luckyspin, which the doc's "20 spins left but no ads" bug came from sharing, is
      // untouched by it.
      const spinIntent = await intentRequest(userId, 'luckyspin');
      expect(spinIntent.statusCode).toBe(200);
      expect(spinIntent.json<IntentResponseBody>().state).toMatchObject({
        daily_cap: 5,
        rewards_remaining: 4,
      });

      const state = await app.inject({
        method: 'GET',
        url: '/earning/rewarded-ad/state?placement=luckyspin',
        headers: { ...APP_HEADERS, authorization: `Bearer ${tokenFor(userId)}` },
      });
      expect(state.statusCode).toBe(200);
      expect(state.json<RewardedAdStateBody>()).toMatchObject({
        daily_cap: 5,
        pending_rewards: 1,
        rewards_remaining: 4,
      });
    });

    it('rejects an unknown placement', async () => {
      const userId = await createTestUser();
      const res = await intentRequest(userId, 'not-a-placement');
      expect(res.statusCode).toBe(400);
    });

    it('mints no coin for a placement whose multiplier is 0, but still consumes the intent', async () => {
      const regionId = await createPlacementRegion({
        luckyspin: { daily_cap: 5, cooldown_s: 0, coin_multiplier: 0 },
      });
      const userId = await createTestUser({ region_id: regionId });

      const intent = await intentRequest(userId, 'luckyspin');
      expect(intent.statusCode).toBe(200);
      const { intent_id: intentId } = intent.json<IntentResponseBody>();

      const callback = await app.inject({
        method: 'GET',
        url: buildSsvUrl({
          ad_network: '5450213213286189855',
          ad_unit: '1234',
          reward_amount: '1',
          reward_item: 'coin',
          timestamp: String(Date.now()),
          transaction_id: randomUUID().replace(/-/g, ''),
          custom_data: intentId,
          key_id: String(KEY_ID),
        }),
      });
      expect(callback.statusCode).toBe(200);

      const consumed = await db
        .selectFrom('rewarded_ad_intents')
        .selectAll()
        .where('id', '=', intentId)
        .executeTakeFirstOrThrow();
      expect(consumed.status).toBe('consumed');
      expect(Number(consumed.coin_awarded)).toBe(0);

      // The impression is still recorded — it is what the quota and the revenue report count.
      const event = await db
        .selectFrom('earning_events')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(event.placement).toBe('luckyspin');
      expect(Number(event.coin_awarded)).toBe(0);

      const ledger = await db
        .selectFrom('coin_ledger')
        .selectAll()
        .where('user_id', '=', userId)
        .where('entry_type', '=', 'REWARDED_AD_CREDIT')
        .execute();
      expect(ledger).toHaveLength(0);
    });

    it('never pays eCPM coin for a checkin ad — POST /checkin/double pays it instead', async () => {
      const regionId = await createPlacementRegion({
        checkin: { daily_cap: 5, cooldown_s: 0, coin_multiplier: 1 },
      });
      const userId = await createTestUser({ region_id: regionId });
      const intent = await intentRequest(userId, 'checkin');
      expect(intent.statusCode).toBe(200);
      const { intent_id: intentId } = intent.json<IntentResponseBody>();

      const callback = await app.inject({
        method: 'GET',
        url: buildSsvUrl({
          ad_network: '5450213213286189855',
          ad_unit: '1234',
          reward_amount: '1',
          reward_item: 'coin',
          timestamp: String(Date.now()),
          transaction_id: randomUUID().replace(/-/g, ''),
          custom_data: intentId,
          key_id: String(KEY_ID),
        }),
      });
      expect(callback.statusCode).toBe(200);

      const consumed = await db
        .selectFrom('rewarded_ad_intents')
        .selectAll()
        .where('id', '=', intentId)
        .executeTakeFirstOrThrow();
      expect(consumed.status).toBe('consumed');
      expect(Number(consumed.coin_awarded)).toBe(0);
      const ledger = await db
        .selectFrom('coin_ledger')
        .select('id')
        .where('user_id', '=', userId)
        .execute();
      expect(ledger).toHaveLength(0);
    });
  });

  describe('verifier key store', () => {
    const CONTENT = 'ad_network=1&transaction_id=abc';

    function countingFetcher(keys: VerifierKey[]): VerifierKeyFetcher & { calls: number } {
      return {
        calls: 0,
        fetch(): Promise<VerifierKey[]> {
          this.calls += 1;
          return Promise.resolve(keys);
        },
      };
    }

    it('verifies a DER-encoded signature and rejects a raw ieee-p1363 one', async () => {
      const store = createVerifierKeyStore(countingFetcher([{ keyId: KEY_ID, pem: publicKeyPem }]));
      const der = cryptoSign('sha256', Buffer.from(CONTENT), {
        key: privateKey,
        dsaEncoding: 'der',
      }).toString('base64url');
      const p1363 = cryptoSign('sha256', Buffer.from(CONTENT), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url');

      expect(await store.verify(CONTENT, der, KEY_ID)).toBe(true);
      // Guards the encoding against regressing back to the pre-go-live assumption.
      expect(await store.verify(CONTENT, p1363, KEY_ID)).toBe(false);
    });

    it('refetches once when an unknown key_id shows up, then serves it from cache', async () => {
      const fetcher = countingFetcher([{ keyId: KEY_ID, pem: publicKeyPem }]);
      const store = createVerifierKeyStore(fetcher);
      const signature = cryptoSign('sha256', Buffer.from(CONTENT), {
        key: privateKey,
        dsaEncoding: 'der',
      }).toString('base64url');

      expect(await store.verify(CONTENT, signature, KEY_ID)).toBe(true);
      expect(fetcher.calls).toBe(1);

      // A key id we do not hold is the rotation signal — but the 60s backoff keeps a flood of
      // callbacks for an unpublished key from issuing one outbound request each.
      expect(await store.verify(CONTENT, signature, 9999)).toBe(false);
      expect(await store.verify(CONTENT, signature, 9999)).toBe(false);
      expect(fetcher.calls).toBe(1);

      expect(await store.verify(CONTENT, signature, KEY_ID)).toBe(true);
      expect(fetcher.calls).toBe(1);
    });

    it('keeps serving a warm cache when the key server fails', async () => {
      let keys: VerifierKey[] = [{ keyId: KEY_ID, pem: publicKeyPem }];
      const store = createVerifierKeyStore({
        fetch: (): Promise<VerifierKey[]> => Promise.resolve(keys),
      });
      const signature = cryptoSign('sha256', Buffer.from(CONTENT), {
        key: privateKey,
        dsaEncoding: 'der',
      }).toString('base64url');

      expect(await store.verify(CONTENT, signature, KEY_ID)).toBe(true);
      keys = []; // gstatic outage
      expect(await store.verify(CONTENT, signature, KEY_ID)).toBe(true);
    });
  });
});
