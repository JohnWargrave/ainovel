import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { uuidv7 } from 'uuidv7';
import { db } from '../../src/db/index.js';
import {
  credit,
  creditPending,
  debit,
  releaseHold,
} from '../../src/modules/wallet-ledger/ledger.service.js';

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

describe('ledger service', () => {
  it('credit increases available_coin and debit decreases it', async () => {
    const userId = await createTestUser();

    const creditResult = await credit({
      userId,
      entryType: 'CHECKIN_CREDIT',
      amount: 500,
      idempotencyKey: `checkin:${userId}:1`,
    });
    expect(creditResult.balanceAfter).toBe('500');

    const debitResult = await debit({ userId, entryType: 'SPIN_TICKET_DEBIT', amount: 200 });
    expect(debitResult.balanceAfter).toBe('300');

    const wallet = await db
      .selectFrom('wallets')
      .select(['available_coin'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(wallet.available_coin).toBe('300');
  });

  it('rejects a debit past the available balance', async () => {
    const userId = await createTestUser();
    await credit({
      userId,
      entryType: 'CHECKIN_CREDIT',
      amount: 100,
      idempotencyKey: `checkin:${userId}:1`,
    });

    await expect(
      debit({ userId, entryType: 'SPIN_TICKET_DEBIT', amount: 1000 }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
  });

  it('dedupes credits sharing an idempotency key', async () => {
    const userId = await createTestUser();
    const idempotencyKey = `checkin:${userId}:dedupe`;

    const first = await credit({
      userId,
      entryType: 'CHECKIN_CREDIT',
      amount: 100,
      idempotencyKey,
    });
    const second = await credit({
      userId,
      entryType: 'CHECKIN_CREDIT',
      amount: 100,
      idempotencyKey,
    });

    expect(second.deduped).toBe(true);
    expect(second.balanceAfter).toBe(first.balanceAfter);

    const wallet = await db
      .selectFrom('wallets')
      .select(['available_coin'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(wallet.available_coin).toBe('100');
  });

  it('enforces the I2 unbacked rolling cap (20,000 coin / 30 days)', async () => {
    const userId = await createTestUser();
    for (let i = 0; i < 20; i += 1) {
      await credit({
        userId,
        entryType: 'CHECKIN_CREDIT',
        amount: 1000,
        idempotencyKey: `checkin:${userId}:${String(i)}`,
      });
    }

    await expect(
      credit({
        userId,
        entryType: 'CHECKIN_CREDIT',
        amount: 1000,
        idempotencyKey: `checkin:${userId}:final`,
      }),
    ).rejects.toMatchObject({ code: 'UNBACKED_CAP_EXCEEDED' });
  });

  it('allows a configured one-time auth reward above the cap but blocks later free coin', async () => {
    const userId = await createTestUser();
    await credit({
      userId,
      entryType: 'WELCOME_CREDIT',
      amount: 100_000,
      idempotencyKey: `welcome:${userId}`,
    });

    const wallet = await db
      .selectFrom('wallets')
      .select('available_coin')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(wallet.available_coin).toBe('100000');

    await expect(
      credit({
        userId,
        entryType: 'CHECKIN_CREDIT',
        amount: 1,
        idempotencyKey: `checkin:${userId}:after-welcome`,
      }),
    ).rejects.toMatchObject({ code: 'UNBACKED_CAP_EXCEEDED' });
  });

  it('releases a matured hold from pending to available', async () => {
    const userId = await createTestUser();
    const holdUntil = new Date(Date.now() - 1000);

    const pendingResult = await creditPending({
      userId,
      entryType: 'OFFERWALL_CREDIT',
      amount: 400,
      holdUntil,
      idempotencyKey: `offerwall:${userId}:1`,
    });

    const before = await db
      .selectFrom('wallets')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(before.pending_coin).toBe('400');
    expect(before.available_coin).toBe('0');

    const release = await releaseHold(pendingResult.ledgerId);
    expect(release.released).toBe(true);

    const after = await db
      .selectFrom('wallets')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(after.pending_coin).toBe('0');
    expect(after.available_coin).toBe('400');

    const noop = await releaseHold(pendingResult.ledgerId);
    expect(noop.released).toBe(false);
  });
});
