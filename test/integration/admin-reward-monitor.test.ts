import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';

const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

interface MonitorBody {
  network: string;
  summary: {
    callbacks_received: number;
    callbacks_not_credited: number;
    rewards_credited: number;
    coins_credited: string;
    unique_users: number;
    latest_credit_at: string | null;
  };
  rewards: {
    user_id: string;
    transaction_id: string;
    coins_awarded: string;
    bucket: string;
    available_balance_after: string;
    hold_until: string | null;
  }[];
  recent_callbacks: {
    verdict: string;
    user_id: string | null;
    transaction_id: string | null;
    earning_event_id: string | null;
  }[];
}

function adminHeaders(adminUserId: string): Record<string, string> {
  return {
    'x-admin-api-key': ADMIN_API_KEY,
    'x-admin-user-id': adminUserId,
    'x-csrf-token': ADMIN_CSRF_TOKEN,
  };
}

describe('admin Tapjoy and PubScale reward monitors', () => {
  let app: FastifyInstance;
  const regionId = `RM_${randomUUID().slice(0, 8)}`;
  const adminId = uuidv7();
  const userId = uuidv7();
  const secondUserId = uuidv7();
  const tapjoyEventId = uuidv7();
  const pubscaleEventId = uuidv7();
  const tapjoyAcceptedLogId = uuidv7();
  const tapjoyQuarantinedLogId = uuidv7();
  const pubscaleAcceptedLogId = uuidv7();
  const tapjoyTransactionId = `tapjoy-${randomUUID()}`;
  const pubscaleTransactionId = `pubscale-${randomUUID()}`;

  beforeAll(async () => {
    app = await buildApp();
    await db
      .insertInto('region_config')
      .values({ region_id: regionId, countries: [], features: {} })
      .execute();
    await db
      .insertInto('admin_users')
      .values({ id: adminId, email: `reward-monitor-${randomUUID()}@test.local`, role: 'analyst' })
      .execute();
    await db
      .insertInto('users')
      .values([
        {
          id: userId,
          auth_provider: 'guest',
          auth_subject: `reward-monitor-${randomUUID()}`,
          email: null,
          country_code: 'VN',
          region_id: regionId,
        },
        {
          id: secondUserId,
          auth_provider: 'guest',
          auth_subject: `reward-monitor-${randomUUID()}`,
          email: null,
          country_code: 'VN',
          region_id: regionId,
        },
      ])
      .execute();
    await db
      .insertInto('wallets')
      .values([
        { user_id: userId, available_coin: 125, pending_coin: 350 },
        { user_id: secondUserId, available_coin: 80, pending_coin: 400 },
      ])
      .execute();
    await db
      .insertInto('earning_events')
      .values([
        {
          id: tapjoyEventId,
          user_id: userId,
          device_id: null,
          source: 'tapjoy',
          network_tx_id: tapjoyTransactionId,
          payout_usd: '1',
          coin_awarded: 350,
          share_applied: '0.35',
          geo_at_event: null,
          ip_at_event: null,
          raw_payload: JSON.stringify({ verifier: 'must-never-reach-cms' }),
        },
        {
          id: pubscaleEventId,
          user_id: secondUserId,
          device_id: null,
          source: 'pubscale',
          network_tx_id: pubscaleTransactionId,
          payout_usd: '1',
          coin_awarded: 400,
          share_applied: '0.4',
          geo_at_event: null,
          ip_at_event: null,
          raw_payload: JSON.stringify({ signature: 'must-never-reach-cms' }),
        },
      ])
      .execute();
    await db
      .insertInto('coin_ledger')
      .values([
        {
          id: tapjoyAcceptedLogId,
          user_id: userId,
          entry_type: 'OFFERWALL_CREDIT',
          amount: 350,
          bucket: 'pending',
          ref_type: 'earning_event',
          ref_id: tapjoyEventId,
          balance_after: 125,
          idempotency_key: `tapjoy:${tapjoyTransactionId}`,
          hold_until: new Date(Date.now() + 48 * 60 * 60 * 1000),
        },
        {
          id: tapjoyQuarantinedLogId,
          user_id: secondUserId,
          entry_type: 'OFFERWALL_CREDIT',
          amount: 400,
          bucket: 'pending',
          ref_type: 'earning_event',
          ref_id: pubscaleEventId,
          balance_after: 80,
          idempotency_key: `pubscale:${pubscaleTransactionId}`,
          hold_until: new Date(Date.now() + 48 * 60 * 60 * 1000),
        },
      ])
      .execute();
    await db
      .insertInto('postback_logs')
      .values([
        {
          id: pubscaleAcceptedLogId,
          network: 'tapjoy',
          remote_ip: '10.10.0.1',
          query_params: JSON.stringify({
            id: tapjoyTransactionId,
            snuid: userId,
            verifier: 'secret-verifier',
          }),
          verdict: 'accepted',
          earning_event_id: tapjoyEventId,
        },
        {
          id: uuidv7(),
          network: 'tapjoy',
          remote_ip: '10.10.0.2',
          query_params: JSON.stringify({
            id: 'tapjoy-no-credit',
            snuid: userId,
            verifier: 'secret-verifier',
          }),
          verdict: 'quarantined',
          earning_event_id: null,
        },
        {
          id: uuidv7(),
          network: 'pubscale',
          remote_ip: '10.10.0.3',
          query_params: JSON.stringify({
            token: pubscaleTransactionId,
            user_id: secondUserId,
            signature: 'secret-signature',
          }),
          verdict: 'accepted',
          earning_event_id: pubscaleEventId,
        },
      ])
      .execute();
  });

  afterAll(async () => {
    await db
      .deleteFrom('postback_logs')
      .where((eb) =>
        eb.or([
          eb('id', 'in', [tapjoyAcceptedLogId, tapjoyQuarantinedLogId, pubscaleAcceptedLogId]),
          eb('earning_event_id', 'in', [tapjoyEventId, pubscaleEventId]),
        ]),
      )
      .execute();
    await db
      .deleteFrom('coin_ledger')
      .where('ref_id', 'in', [tapjoyEventId, pubscaleEventId])
      .execute();
    await db
      .deleteFrom('earning_events')
      .where('id', 'in', [tapjoyEventId, pubscaleEventId])
      .execute();
    await db.deleteFrom('wallets').where('user_id', 'in', [userId, secondUserId]).execute();
    await db.deleteFrom('users').where('id', 'in', [userId, secondUserId]).execute();
    await db.deleteFrom('admin_users').where('id', '=', adminId).execute();
    await db.deleteFrom('region_config').where('region_id', '=', regionId).execute();
    await app.close();
  });

  it('separates confirmed Tapjoy gains from callbacks that did not credit', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/admin/reward-monitors/tapjoy?window_hours=24&user_id=${userId}`,
      headers: adminHeaders(adminId),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<MonitorBody>();
    expect(body.network).toBe('tapjoy');
    expect(body.summary).toMatchObject({
      callbacks_received: 2,
      callbacks_not_credited: 1,
      rewards_credited: 1,
      coins_credited: '350',
      unique_users: 1,
    });
    expect(body.summary.latest_credit_at).not.toBeNull();
    expect(body.rewards[0]).toMatchObject({
      user_id: userId,
      transaction_id: tapjoyTransactionId,
      coins_awarded: '350',
      bucket: 'pending',
      available_balance_after: '125',
    });
    expect(body.rewards[0]?.hold_until).not.toBeNull();
    expect(body.recent_callbacks.map((callback) => callback.verdict).sort()).toEqual([
      'accepted',
      'quarantined',
    ]);
    expect(response.body).not.toContain('secret-verifier');
    expect(response.body).not.toContain('query_params');
  });

  it('uses PubScale token and user_id for exact filters', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/admin/reward-monitors/pubscale?transaction_id=${pubscaleTransactionId}`,
      headers: adminHeaders(adminId),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<MonitorBody>();
    expect(body.summary).toMatchObject({
      callbacks_received: 1,
      callbacks_not_credited: 0,
      rewards_credited: 1,
      coins_credited: '400',
    });
    expect(body.rewards[0]?.user_id).toBe(secondUserId);
    expect(body.recent_callbacks[0]).toMatchObject({
      verdict: 'accepted',
      user_id: secondUserId,
      transaction_id: pubscaleTransactionId,
      earning_event_id: pubscaleEventId,
    });
    expect(response.body).not.toContain('secret-signature');
  });

  it('requires a CMS role and rejects unsupported providers', async () => {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/admin/reward-monitors/tapjoy',
    });
    expect(unauthenticated.statusCode).toBe(401);

    const unsupported = await app.inject({
      method: 'GET',
      url: '/admin/reward-monitors/adgate',
      headers: adminHeaders(adminId),
    });
    expect(unsupported.statusCode).toBe(400);

    const invalidUserId = await app.inject({
      method: 'GET',
      url: '/admin/reward-monitors/tapjoy?user_id=not-a-uuid',
      headers: adminHeaders(adminId),
    });
    expect(invalidUserId.statusCode).toBe(400);
  });
});
