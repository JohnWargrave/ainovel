import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import {
  processIpAllowlistRefreshScan,
  type IpRangeSource,
} from '../../src/jobs/ip-allowlist-refresh.js';

interface ErrorResponseBody {
  error: { code: string; message: string };
}

async function createTestUser(): Promise<string> {
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
      region_id: 'VN',
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId }).execute();
  return userId;
}

async function setAllowedIps(network: string, ips: string[]): Promise<void> {
  await db
    .updateTable('network_config')
    .set({ allowed_ips: ips })
    .where('network', '=', network)
    .execute();
}

async function getSecretKey(network: string): Promise<string> {
  const row = await db
    .selectFrom('network_config')
    .select('secret_key')
    .where('network', '=', network)
    .executeTakeFirstOrThrow();
  return row.secret_key;
}

function tapjoyVerifier(id: string, snuid: string, currency: string, secret: string): string {
  return createHash('md5').update(`${id}:${snuid}:${currency}:${secret}`).digest('hex');
}

describe('postback gateway', () => {
  let app: FastifyInstance;
  let tapjoySecret: string;
  let originalTapjoyImmediateCredit: boolean;

  beforeAll(async () => {
    app = await buildApp();
    tapjoySecret = await getSecretKey('tapjoy');
    originalTapjoyImmediateCredit = (
      await db
        .selectFrom('network_config')
        .select('credit_immediately')
        .where('network', '=', 'tapjoy')
        .executeTakeFirstOrThrow()
    ).credit_immediately;
    await setAllowedIps('tapjoy', ['10.1.1.1/32', '10.1.1.2/32', '10.1.1.3/32', '10.1.1.7/32']);
    await setAllowedIps('adgate', ['10.1.1.6/32']);
    await db
      .updateTable('network_config')
      .set({ shadow_mode: false, credit_immediately: false })
      .where('network', '=', 'tapjoy')
      .execute();
  });

  afterAll(async () => {
    await app.close();
    await setAllowedIps('tapjoy', []);
    await setAllowedIps('adgate', []);
    await db
      .updateTable('network_config')
      .set({ shadow_mode: true, credit_immediately: originalTapjoyImmediateCredit })
      .where('network', '=', 'tapjoy')
      .execute();
  });

  it('Tapjoy: valid postback credits pending coin, 48h hold for payout <= $5', async () => {
    const userId = await createTestUser();
    const netTxId = `tj-${randomUUID()}`;
    const currency = '2000'; // payout_usd = 2000 / 1000 = 2

    const res = await app.inject({
      method: 'GET',
      url: '/postback/tapjoy',
      remoteAddress: '10.1.1.1',
      query: {
        id: netTxId,
        snuid: userId,
        currency,
        verifier: tapjoyVerifier(netTxId, userId, currency, tapjoySecret),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1');
    // Tapjoy retries every 5 minutes for up to four days when a response isn't UTF-8 encoded — even
    // on a 200. Declaring the charset is what stops a silent four-day retry loop.
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');

    const event = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('source', '=', 'tapjoy')
      .where('network_tx_id', '=', netTxId)
      .executeTakeFirstOrThrow();
    expect(event.coin_awarded).toBe('6000'); // 2 * 10000 * 0.3 (trust_level 0 share)
    expect(event.payout_usd).toBe('2.0000');
    expect(event.status).toBe('credited');

    const ledgerEntry = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('ref_type', '=', 'earning_event')
      .where('ref_id', '=', event.id)
      .where('entry_type', '=', 'OFFERWALL_CREDIT')
      .executeTakeFirstOrThrow();
    expect(ledgerEntry.amount).toBe('6000');
    expect(ledgerEntry.bucket).toBe('pending');
    const holdUntilMs = new Date(ledgerEntry.hold_until ?? 0).getTime();
    expect(Math.abs(holdUntilMs - (Date.now() + 48 * 60 * 60 * 1000))).toBeLessThan(10_000);

    const wallet = await db
      .selectFrom('wallets')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(wallet.pending_coin).toBe('6000');

    const log = await db
      .selectFrom('postback_logs')
      .selectAll()
      .where('earning_event_id', '=', event.id)
      .executeTakeFirstOrThrow();
    expect(log.verdict).toBe('accepted');
  });

  it('Tapjoy: resolves the provider IP through an explicitly trusted proxy', async () => {
    const userId = await createTestUser();
    const netTxId = `tj-${randomUUID()}`;
    const currency = '1000';

    const res = await app.inject({
      method: 'GET',
      url: '/postback/tapjoy',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '10.1.1.1' },
      query: {
        id: netTxId,
        snuid: userId,
        currency,
        verifier: tapjoyVerifier(netTxId, userId, currency, tapjoySecret),
      },
    });
    expect(res.statusCode).toBe(200);

    const log = await db
      .selectFrom('postback_logs')
      .select(['remote_ip', 'verdict'])
      .where('network', '=', 'tapjoy')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(log).toMatchObject({ remote_ip: '10.1.1.1', verdict: 'accepted' });
  });

  it('Tapjoy: payout > $5 holds for 72h', async () => {
    const userId = await createTestUser();
    const netTxId = `tj-${randomUUID()}`;
    const currency = '6000'; // payout_usd = 6

    const res = await app.inject({
      method: 'GET',
      url: '/postback/tapjoy',
      remoteAddress: '10.1.1.2',
      query: {
        id: netTxId,
        snuid: userId,
        currency,
        verifier: tapjoyVerifier(netTxId, userId, currency, tapjoySecret),
      },
    });
    expect(res.statusCode).toBe(200);

    const event = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('source', '=', 'tapjoy')
      .where('network_tx_id', '=', netTxId)
      .executeTakeFirstOrThrow();
    expect(event.coin_awarded).toBe('18000'); // 6 * 10000 * 0.3

    const ledgerEntry = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('ref_type', '=', 'earning_event')
      .where('ref_id', '=', event.id)
      .executeTakeFirstOrThrow();
    const holdUntilMs = new Date(ledgerEntry.hold_until ?? 0).getTime();
    expect(Math.abs(holdUntilMs - (Date.now() + 72 * 60 * 60 * 1000))).toBeLessThan(10_000);
  });

  it('Tapjoy: applies the provider-configured standard and high-value hold policy', async () => {
    const original = await db
      .selectFrom('network_config')
      .select(['hold_hours', 'high_value_threshold_usd', 'high_value_hold_hours'])
      .where('network', '=', 'tapjoy')
      .executeTakeFirstOrThrow();
    await db
      .updateTable('network_config')
      .set({ hold_hours: 1, high_value_threshold_usd: 2, high_value_hold_hours: 4 })
      .where('network', '=', 'tapjoy')
      .execute();

    try {
      const cases = [
        { currency: '2000', expectedHoldHours: 1 },
        { currency: '3000', expectedHoldHours: 4 },
      ];
      for (const testCase of cases) {
        const userId = await createTestUser();
        const netTxId = `tj-policy-${randomUUID()}`;
        const res = await app.inject({
          method: 'GET',
          url: '/postback/tapjoy',
          remoteAddress: '10.1.1.2',
          query: {
            id: netTxId,
            snuid: userId,
            currency: testCase.currency,
            verifier: tapjoyVerifier(netTxId, userId, testCase.currency, tapjoySecret),
          },
        });
        expect(res.statusCode).toBe(200);

        const event = await db
          .selectFrom('earning_events')
          .select('id')
          .where('source', '=', 'tapjoy')
          .where('network_tx_id', '=', netTxId)
          .executeTakeFirstOrThrow();
        const ledgerEntry = await db
          .selectFrom('coin_ledger')
          .select('hold_until')
          .where('ref_type', '=', 'earning_event')
          .where('ref_id', '=', event.id)
          .where('entry_type', '=', 'OFFERWALL_CREDIT')
          .executeTakeFirstOrThrow();
        const holdUntilMs = new Date(ledgerEntry.hold_until ?? 0).getTime();
        expect(
          Math.abs(holdUntilMs - (Date.now() + testCase.expectedHoldHours * 60 * 60 * 1000)),
        ).toBeLessThan(10_000);
      }
    } finally {
      await db
        .updateTable('network_config')
        .set(original)
        .where('network', '=', 'tapjoy')
        .execute();
    }
  });

  it('Tapjoy: credits the available wallet immediately when configured', async () => {
    const userId = await createTestUser();
    const netTxId = `tj-immediate-${randomUUID()}`;
    const currency = '2000';
    await db
      .updateTable('network_config')
      .set({ credit_immediately: true })
      .where('network', '=', 'tapjoy')
      .execute();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/postback/tapjoy',
        remoteAddress: '10.1.1.2',
        query: {
          id: netTxId,
          snuid: userId,
          currency,
          verifier: tapjoyVerifier(netTxId, userId, currency, tapjoySecret),
        },
      });
      expect(res.statusCode).toBe(200);

      const event = await db
        .selectFrom('earning_events')
        .select('id')
        .where('source', '=', 'tapjoy')
        .where('network_tx_id', '=', netTxId)
        .executeTakeFirstOrThrow();
      const ledgerEntry = await db
        .selectFrom('coin_ledger')
        .select(['bucket', 'hold_until'])
        .where('ref_type', '=', 'earning_event')
        .where('ref_id', '=', event.id)
        .where('entry_type', '=', 'OFFERWALL_CREDIT')
        .executeTakeFirstOrThrow();
      expect(ledgerEntry).toMatchObject({ bucket: 'available', hold_until: null });

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
        .where('network', '=', 'tapjoy')
        .execute();
    }
  });

  it('Tapjoy: duplicate network_tx_id is a 200 no-op, not a double credit', async () => {
    const userId = await createTestUser();
    const netTxId = `tj-${randomUUID()}`;
    const currency = '1000';
    const query = {
      id: netTxId,
      snuid: userId,
      currency,
      verifier: tapjoyVerifier(netTxId, userId, currency, tapjoySecret),
    };

    const first = await app.inject({
      method: 'GET',
      url: '/postback/tapjoy',
      remoteAddress: '10.1.1.3',
      query,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'GET',
      url: '/postback/tapjoy',
      remoteAddress: '10.1.1.3',
      query,
    });
    expect(second.statusCode).toBe(200);

    const events = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('source', '=', 'tapjoy')
      .where('network_tx_id', '=', netTxId)
      .execute();
    expect(events).toHaveLength(1);

    const wallet = await db
      .selectFrom('wallets')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(wallet.pending_coin).toBe('3000'); // 1 * 10000 * 0.3, credited exactly once

    const logs = await db
      .selectFrom('postback_logs')
      .selectAll()
      .where('earning_event_id', '=', events[0]?.id ?? '')
      .orderBy('created_at', 'asc')
      .execute();
    expect(logs.at(-1)?.verdict).toBe('duplicate');
  });

  it('Tapjoy: bad signature is rejected with 403 and logged as bad_signature', async () => {
    const userId = await createTestUser();
    const netTxId = `tj-${randomUUID()}`;

    const res = await app.inject({
      method: 'GET',
      url: '/postback/tapjoy',
      remoteAddress: '10.1.1.1',
      query: { id: netTxId, snuid: userId, currency: '1000', verifier: 'not-the-real-verifier' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorResponseBody>().error.code).toBe('BAD_SIGNATURE');

    const log = await db
      .selectFrom('postback_logs')
      .selectAll()
      .where('network', '=', 'tapjoy')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(log.verdict).toBe('bad_signature');

    const events = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('source', '=', 'tapjoy')
      .where('network_tx_id', '=', netTxId)
      .execute();
    expect(events).toHaveLength(0);
  });

  it('Tapjoy: valid signature from a non-allowlisted IP is quarantined, not credited', async () => {
    const userId = await createTestUser();
    const netTxId = `tj-${randomUUID()}`;
    const currency = '1000';

    const res = await app.inject({
      method: 'GET',
      url: '/postback/tapjoy',
      remoteAddress: '10.1.1.99', // deliberately not in the tapjoy allowlist set in beforeAll
      query: {
        id: netTxId,
        snuid: userId,
        currency,
        verifier: tapjoyVerifier(netTxId, userId, currency, tapjoySecret),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1');

    const log = await db
      .selectFrom('postback_logs')
      .selectAll()
      .where('network', '=', 'tapjoy')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(log.verdict).toBe('quarantined');

    const events = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('source', '=', 'tapjoy')
      .where('network_tx_id', '=', netTxId)
      .execute();
    expect(events).toHaveLength(0);
  });

  it('Tapjoy: user_not_found is a 200 no-op', async () => {
    const netTxId = `tj-${randomUUID()}`;
    const currency = '1000';
    const bogusUserId = randomUUID();

    const res = await app.inject({
      method: 'GET',
      url: '/postback/tapjoy',
      remoteAddress: '10.1.1.1',
      query: {
        id: netTxId,
        snuid: bogusUserId,
        currency,
        verifier: tapjoyVerifier(netTxId, bogusUserId, currency, tapjoySecret),
      },
    });

    expect(res.statusCode).toBe(200);
    const log = await db
      .selectFrom('postback_logs')
      .selectAll()
      .where('network', '=', 'tapjoy')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(log.verdict).toBe('user_not_found');
  });

  it('Tapjoy: shadow_mode credits nothing but still logs accepted', async () => {
    const userId = await createTestUser();
    const netTxId = `tj-${randomUUID()}`;
    const currency = '1000';

    await db
      .updateTable('network_config')
      .set({ shadow_mode: true })
      .where('network', '=', 'tapjoy')
      .execute();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/postback/tapjoy',
        remoteAddress: '10.1.1.7',
        query: {
          id: netTxId,
          snuid: userId,
          currency,
          verifier: tapjoyVerifier(netTxId, userId, currency, tapjoySecret),
        },
      });
      expect(res.statusCode).toBe(200);

      const events = await db
        .selectFrom('earning_events')
        .selectAll()
        .where('source', '=', 'tapjoy')
        .where('network_tx_id', '=', netTxId)
        .execute();
      expect(events).toHaveLength(0);

      const wallet = await db
        .selectFrom('wallets')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(wallet.pending_coin).toBe('0');

      const log = await db
        .selectFrom('postback_logs')
        .selectAll()
        .where('network', '=', 'tapjoy')
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      expect(log.verdict).toBe('accepted');
      expect(log.earning_event_id).toBeNull();
    } finally {
      await db
        .updateTable('network_config')
        .set({ shadow_mode: false })
        .where('network', '=', 'tapjoy')
        .execute();
    }
  });

  it('AdGate: valid postback credits, then a reversal claws back the still-held pending coin', async () => {
    const userId = await createTestUser();
    const txId = `ag-${randomUUID()}`;

    const creditRes = await app.inject({
      method: 'GET',
      url: '/postback/adgate',
      remoteAddress: '10.1.1.6',
      query: { tx_id: txId, user_id: userId, payout: '3', status: '1' },
    });
    expect(creditRes.statusCode).toBe(200);

    const event = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('source', '=', 'adgate')
      .where('network_tx_id', '=', txId)
      .executeTakeFirstOrThrow();
    expect(event.coin_awarded).toBe('9000'); // 3 * 10000 * 0.3

    const walletAfterCredit = await db
      .selectFrom('wallets')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(walletAfterCredit.pending_coin).toBe('9000');

    const reversalRes = await app.inject({
      method: 'GET',
      url: '/postback/adgate',
      remoteAddress: '10.1.1.6',
      query: { tx_id: txId, user_id: userId, payout: '3', status: '0' },
    });
    expect(reversalRes.statusCode).toBe(200);

    const eventAfter = await db
      .selectFrom('earning_events')
      .selectAll()
      .where('id', '=', event.id)
      .executeTakeFirstOrThrow();
    expect(eventAfter.status).toBe('clawed_back');

    const clawback = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('ref_type', '=', 'earning_event')
      .where('ref_id', '=', event.id)
      .where('entry_type', '=', 'OFFERWALL_CLAWBACK')
      .executeTakeFirstOrThrow();
    expect(clawback.amount).toBe('-9000');
    expect(clawback.bucket).toBe('pending'); // still held, hold_until hadn't matured

    const walletAfterReversal = await db
      .selectFrom('wallets')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(walletAfterReversal.pending_coin).toBe('0');
    expect(walletAfterReversal.available_coin).toBe('0');
  });

  it('rate limit: exceeding the per-IP threshold returns 429', async () => {
    const ip = '10.1.1.42';
    const responses = await Promise.all(
      Array.from({ length: 65 }, () =>
        app.inject({
          method: 'GET',
          url: '/postback/adgate',
          remoteAddress: ip,
          query: {},
        }),
      ),
    );
    expect(responses.some((res) => res.statusCode === 429)).toBe(true);
  });

  it('ip-allowlist-refresh: drift is flagged into audit_log, allowed_ips is never auto-applied', async () => {
    const before = await db
      .selectFrom('network_config')
      .select('allowed_ips')
      .where('network', '=', 'tapjoy')
      .executeTakeFirstOrThrow();

    const fakeSource: IpRangeSource = {
      fetch: (network: string): Promise<string[] | null> =>
        Promise.resolve(network === 'tapjoy' ? ['203.0.113.0/24'] : null),
    };

    await processIpAllowlistRefreshScan(pino({ level: 'silent' }), fakeSource);

    const after = await db
      .selectFrom('network_config')
      .select('allowed_ips')
      .where('network', '=', 'tapjoy')
      .executeTakeFirstOrThrow();
    expect(after.allowed_ips).toEqual(before.allowed_ips);

    const drift = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'IP_ALLOWLIST_DRIFT_DETECTED')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    const detail = drift.detail as { network: string; detected: string[] };
    expect(detail.network).toBe('tapjoy');
    expect(detail.detected).toEqual(['203.0.113.0/24']);
  });
});
