import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';

const NETWORK = 'pubscale';
// The test IP stands in for PubScale's published callback addresses — the real ones are seeded in
// 1700000000026 and swapped out here so the suite doesn't depend on their upstream IPs staying put.
const ALLOWED_IP = '10.2.2.1';

interface ErrorResponseBody {
  error: { code: string; message: string };
}

async function createTestUser(): Promise<string> {
  const userId = uuidv7();
  await db
    .insertInto('users')
    .values({
      id: userId,
      auth_provider: 'guest',
      auth_subject: `test-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: 'VN',
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId }).execute();
  return userId;
}

async function getSecretKey(): Promise<string> {
  const row = await db
    .selectFrom('network_config')
    .select('secret_key')
    .where('network', '=', NETWORK)
    .executeTakeFirstOrThrow();
  return row.secret_key;
}

async function setShadowMode(enabled: boolean): Promise<void> {
  await db
    .updateTable('network_config')
    .set({ shadow_mode: enabled })
    .where('network', '=', NETWORK)
    .execute();
}

// Mirrors the documented formula: hex(md5(secret_key . user_id . trunc(value) . token)).
function pubscaleSignature(secret: string, userId: string, value: string, token: string): string {
  return createHash('md5')
    .update(`${secret}.${userId}.${String(Math.trunc(Number(value)))}.${token}`)
    .digest('hex');
}

describe('pubscale postback', () => {
  let app: FastifyInstance;
  let secret: string;
  let originalIps: string[];
  let originalImmediateCredit: boolean;

  beforeAll(async () => {
    app = await buildApp();
    secret = await getSecretKey();
    const row = await db
      .selectFrom('network_config')
      .select(['allowed_ips', 'credit_immediately'])
      .where('network', '=', NETWORK)
      .executeTakeFirstOrThrow();
    originalIps = row.allowed_ips;
    originalImmediateCredit = row.credit_immediately;
    await db
      .updateTable('network_config')
      .set({ allowed_ips: [`${ALLOWED_IP}/32`], credit_immediately: false })
      .where('network', '=', NETWORK)
      .execute();
    // Seeded shadow_mode is true (safe rollout default) — most cases here assert real crediting.
    await setShadowMode(false);
  });

  afterAll(async () => {
    await db
      .updateTable('network_config')
      .set({
        allowed_ips: originalIps,
        shadow_mode: true,
        credit_immediately: originalImmediateCredit,
      })
      .where('network', '=', NETWORK)
      .execute();
    await app.close();
  });

  it('credits pending coin on a valid callback and derives USD from the signed value', async () => {
    const userId = await createTestUser();
    const token = `ps-${randomUUID()}`;
    const value = '2000'; // currency_per_usd = 1000 -> $2

    const res = await app.inject({
      method: 'GET',
      url: `/postback/${NETWORK}`,
      remoteAddress: ALLOWED_IP,
      query: {
        user_id: userId,
        value,
        token,
        signature: pubscaleSignature(secret, userId, value, token),
      },
    });
    expect(res.statusCode).toBe(200);

    const event = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('source', '=', NETWORK)
      .where('network_tx_id', '=', token)
      .executeTakeFirstOrThrow();
    expect(event.payout_usd).toBe('2.0000');
    expect(event.coin_awarded).toBe('6000'); // 2 * 10000 * 0.3 (trust level 0 share)
    expect(event.status).toBe('credited');

    const ledger = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('ref_type', '=', 'earning_event')
      .where('ref_id', '=', event.id)
      .where('entry_type', '=', 'OFFERWALL_CREDIT')
      .executeTakeFirstOrThrow();
    expect(ledger.bucket).toBe('pending');
  });

  it('credits the available wallet immediately when configured', async () => {
    const userId = await createTestUser();
    const token = `ps-immediate-${randomUUID()}`;
    const value = '2000';
    await db
      .updateTable('network_config')
      .set({ credit_immediately: true })
      .where('network', '=', NETWORK)
      .execute();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/postback/${NETWORK}`,
        remoteAddress: ALLOWED_IP,
        query: {
          user_id: userId,
          value,
          token,
          signature: pubscaleSignature(secret, userId, value, token),
        },
      });
      expect(res.statusCode).toBe(200);

      const event = await db
        .selectFrom('earning_events')
        .select('id')
        .where('source', '=', NETWORK)
        .where('network_tx_id', '=', token)
        .executeTakeFirstOrThrow();
      const ledger = await db
        .selectFrom('coin_ledger')
        .select(['bucket', 'hold_until'])
        .where('ref_type', '=', 'earning_event')
        .where('ref_id', '=', event.id)
        .where('entry_type', '=', 'OFFERWALL_CREDIT')
        .executeTakeFirstOrThrow();
      expect(ledger).toMatchObject({ bucket: 'available', hold_until: null });

      const wallet = await db
        .selectFrom('wallets')
        .select(['available_coin', 'pending_coin'])
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(wallet).toMatchObject({ available_coin: '6000', pending_coin: '0' });
    } finally {
      await db
        .updateTable('network_config')
        .set({ credit_immediately: false })
        .where('network', '=', NETWORK)
        .execute();
    }
  });

  it('accepts a decimal value, matching the docs truncating it before hashing', async () => {
    const userId = await createTestUser();
    const token = `ps-${randomUUID()}`;
    // The signature covers only the integer part (1500), but payout uses the full 1500.75.
    const value = '1500.75';

    const res = await app.inject({
      method: 'GET',
      url: `/postback/${NETWORK}`,
      remoteAddress: ALLOWED_IP,
      query: {
        user_id: userId,
        value,
        token,
        signature: pubscaleSignature(secret, userId, value, token),
      },
    });
    expect(res.statusCode).toBe(200);

    const event = await db
      .selectFrom('earning_events')
      .select('payout_usd')
      .where('source', '=', NETWORK)
      .where('network_tx_id', '=', token)
      .executeTakeFirstOrThrow();
    expect(event.payout_usd).toBe('1.5008'); // 1500.75 / 1000, stored at NUMERIC(12,4)
  });

  it('rejects a signature built with the wrong secret', async () => {
    const userId = await createTestUser();
    const token = `ps-${randomUUID()}`;
    const value = '1000';

    const res = await app.inject({
      method: 'GET',
      url: `/postback/${NETWORK}`,
      remoteAddress: ALLOWED_IP,
      query: {
        user_id: userId,
        value,
        token,
        signature: pubscaleSignature('wrong-secret', userId, value, token),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorResponseBody>().error.code).toBe('BAD_SIGNATURE');

    const events = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('network_tx_id', '=', token)
      .execute();
    expect(events).toHaveLength(0);
  });

  it('rejects a signature whose field order matches Tapjoy instead of PubScale', async () => {
    // Guards the easiest way to get this wrong: PubScale puts the secret first, Tapjoy last.
    const userId = await createTestUser();
    const token = `ps-${randomUUID()}`;
    const value = '1000';
    const tapjoyOrder = createHash('md5')
      .update(`${userId}.${String(Math.trunc(Number(value)))}.${token}.${secret}`)
      .digest('hex');

    const res = await app.inject({
      method: 'GET',
      url: `/postback/${NETWORK}`,
      remoteAddress: ALLOWED_IP,
      query: { user_id: userId, value, token, signature: tapjoyOrder },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a callback missing a required param', async () => {
    const userId = await createTestUser();

    const res = await app.inject({
      method: 'GET',
      url: `/postback/${NETWORK}`,
      remoteAddress: ALLOWED_IP,
      query: { user_id: userId, value: '1000' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorResponseBody>().error.code).toBe('BAD_SIGNATURE');
  });

  it('does not double-credit a retried callback reusing the same token', async () => {
    const userId = await createTestUser();
    const token = `ps-${randomUUID()}`;
    const value = '1000';
    const query = {
      user_id: userId,
      value,
      token,
      signature: pubscaleSignature(secret, userId, value, token),
    };

    const first = await app.inject({
      method: 'GET',
      url: `/postback/${NETWORK}`,
      remoteAddress: ALLOWED_IP,
      query,
    });
    expect(first.statusCode).toBe(200);

    const walletAfterFirst = await db
      .selectFrom('wallets')
      .select('pending_coin')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    // PubScale retries a failed delivery up to 6 times with the same token — the second delivery must
    // be a no-op, not a second credit.
    const second = await app.inject({
      method: 'GET',
      url: `/postback/${NETWORK}`,
      remoteAddress: ALLOWED_IP,
      query,
    });
    expect(second.statusCode).toBe(200);

    const walletAfterSecond = await db
      .selectFrom('wallets')
      .select('pending_coin')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(walletAfterSecond.pending_coin).toBe(walletAfterFirst.pending_coin);

    const events = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('source', '=', NETWORK)
      .where('network_tx_id', '=', token)
      .execute();
    expect(events).toHaveLength(1);
  });

  it('quarantines a valid callback arriving from an unlisted IP', async () => {
    const userId = await createTestUser();
    const token = `ps-${randomUUID()}`;
    const value = '1000';

    const res = await app.inject({
      method: 'GET',
      url: `/postback/${NETWORK}`,
      remoteAddress: '10.2.2.99',
      query: {
        user_id: userId,
        value,
        token,
        signature: pubscaleSignature(secret, userId, value, token),
      },
    });
    expect(res.statusCode).toBe(200);

    const events = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('network_tx_id', '=', token)
      .execute();
    expect(events).toHaveLength(0);

    const log = await db
      .selectFrom('postback_logs')
      .select('verdict')
      .where('network', '=', NETWORK)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(log.verdict).toBe('quarantined');
  });

  it('ignores the unsigned payout_usd param when computing the credit', async () => {
    // payout_usd is outside PubScale's signature, so it must never drive the money math — a tampered
    // value has to leave the credit derived from the signed `value` alone.
    const userId = await createTestUser();
    const token = `ps-${randomUUID()}`;
    const value = '1000'; // $1 via currency_per_usd

    const res = await app.inject({
      method: 'GET',
      url: `/postback/${NETWORK}`,
      remoteAddress: ALLOWED_IP,
      query: {
        user_id: userId,
        value,
        token,
        payout_usd: '999.00',
        signature: pubscaleSignature(secret, userId, value, token),
      },
    });
    expect(res.statusCode).toBe(200);

    const event = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('source', '=', NETWORK)
      .where('network_tx_id', '=', token)
      .executeTakeFirstOrThrow();
    expect(event.payout_usd).toBe('1.0000');

    // The tampered field is still retained verbatim for dashboard reconciliation.
    const raw = event.raw_payload as Record<string, string>;
    expect(raw['payout_usd']).toBe('999.00');
  });

  it('logs accepted but credits nothing while shadow_mode is on', async () => {
    const userId = await createTestUser();
    const token = `ps-${randomUUID()}`;
    const value = '1000';
    await setShadowMode(true);

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/postback/${NETWORK}`,
        remoteAddress: ALLOWED_IP,
        query: {
          user_id: userId,
          value,
          token,
          signature: pubscaleSignature(secret, userId, value, token),
        },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await setShadowMode(false);
    }

    const events = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('network_tx_id', '=', token)
      .execute();
    expect(events).toHaveLength(0);

    const wallet = await db
      .selectFrom('wallets')
      .select('pending_coin')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(wallet.pending_coin).toBe('0');
  });

  it('returns user_not_found for an unknown user without erroring', async () => {
    const token = `ps-${randomUUID()}`;
    const value = '1000';
    const unknownUserId = uuidv7();

    const res = await app.inject({
      method: 'GET',
      url: `/postback/${NETWORK}`,
      remoteAddress: ALLOWED_IP,
      query: {
        user_id: unknownUserId,
        value,
        token,
        signature: pubscaleSignature(secret, unknownUserId, value, token),
      },
    });
    expect(res.statusCode).toBe(200);

    const log = await db
      .selectFrom('postback_logs')
      .select('verdict')
      .where('network', '=', NETWORK)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(log.verdict).toBe('user_not_found');
  });
});
