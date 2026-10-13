import { uuidv7 } from 'uuidv7';
import type { Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB, LedgerEntryType } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { recordMint, recordRevenue } from './economy-counters.js';
import { isMintPausedInTx } from './mint-switch.js';

// I2 (14-USER-JOURNEY-ECONOMY.md §3): welcome, bind, check-in, tasks and free-spin prizes are the
// unbacked sources. Paid-spin prizes remain separate because they return coin from an existing sink.
// Exported so admin analytics splits mint into backed/unbacked off the same list instead of a second
// copy that could drift from the cap this file enforces.
export const UNBACKED_ENTRY_TYPES: readonly LedgerEntryType[] = [
  'WELCOME_CREDIT',
  'LOGIN_BIND_CREDIT',
  'CHECKIN_CREDIT',
  'TASK_CREDIT',
  'FREE_SPIN_PRIZE_CREDIT',
  // Client-named amounts with no revenue behind them — the definition of unbacked. Listing it here
  // is what subjects POST /earning/coin to the 20,000/30-day rolling cap and the mint kill-switch,
  // which is the only aggregate bound on a feature whose per-request amount the caller chooses.
  'DIRECT_CREDIT',
  // Was written as if backed by interstitial revenue (revenueUsd 0.002 per episode). The reward is
  // now a flat episode_reward_coin from region config with no ad revenue behind it, which is the
  // definition of unbacked — so it belongs under the rolling cap and the kill-switch like every
  // other config-driven payout.
  'DRAMA_WATCH_CREDIT',
  // Flat chapter_reward_coin from region config for finishing a free chapter — no revenue behind it.
  'NOVEL_READ_CREDIT',
];

const ONE_TIME_AUTH_REWARD_TYPES: readonly LedgerEntryType[] = [
  'WELCOME_CREDIT',
  'LOGIN_BIND_CREDIT',
];

const UNBACKED_ROLLING_CAP = 20_000; // I2: 30-day rolling cap, coin ($2)
const UNBACKED_ROLLING_WINDOW_DAYS = 30;
// I2 also specifies unbacked lifetime <= 35% of lifetime minted, deferred — see enforceUnbackedCap.

export interface CreditParams {
  userId: string;
  entryType: LedgerEntryType;
  amount: number; // positive coin amount
  bucket?: 'available' | 'pending';
  holdUntil?: Date; // required when bucket === 'pending'
  refType?: string;
  refId?: string;
  idempotencyKey?: string;
  note?: string;
  revenueUsd?: number; // real USD backing this credit, for I6 (default 0 — e.g. welcome/bind bonuses)
}

export interface DebitParams {
  userId: string;
  entryType: LedgerEntryType;
  amount: number; // positive magnitude to remove
  bucket?: 'available' | 'pending';
  refType?: string;
  refId?: string;
  idempotencyKey?: string;
  note?: string;
  allowNegative?: boolean; // clawback-style debits allowed to push available_coin below 0
}

export interface LedgerResult {
  ledgerId: string;
  balanceAfter: string;
  deduped: boolean;
}

function assertPositiveInteger(amount: number, label: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AppError('INVALID_AMOUNT', `${label} must be a positive integer`, 400);
  }
}

async function findDeduped(
  trx: Transaction<DB>,
  idempotencyKey: string | undefined,
): Promise<LedgerResult | null> {
  if (!idempotencyKey) return null;
  const existing = await trx
    .selectFrom('coin_ledger')
    .select(['id', 'balance_after'])
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
  if (!existing) return null;
  return { ledgerId: existing.id, balanceAfter: existing.balance_after, deduped: true };
}

// I2 also specifies unbacked lifetime <= 35% of lifetime minted — deferred, same reasoning as
// I1/I3/I4/I5/I7/I8: it's only meaningful once a backed earning source exists (Postback Gateway /
// Rewarded Video SSV, later milestones). Until then every user's lifetime coin IS unbacked coin by
// construction, so a real-time ratio check would reject the very first WELCOME_CREDIT of every signup.
async function enforceUnbackedCap(
  trx: Transaction<DB>,
  userId: string,
  amount: number,
): Promise<void> {
  const windowStart = new Date(Date.now() - UNBACKED_ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rolling = await trx
    .selectFrom('coin_ledger')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('amount'), eb.lit(0)).as('total'))
    .where('user_id', '=', userId)
    .where('entry_type', 'in', UNBACKED_ENTRY_TYPES)
    .where('created_at', '>=', windowStart)
    .executeTakeFirstOrThrow();

  if (BigInt(rolling.total) + BigInt(amount) > BigInt(UNBACKED_ROLLING_CAP)) {
    throw new AppError(
      'UNBACKED_CAP_EXCEEDED',
      'Free-coin cap reached for now, come back tomorrow',
      429,
    );
  }
}

// Core primitive: SELECT wallet FOR UPDATE + INSERT ledger + UPDATE wallet, all in the caller's
// transaction (02-DATABASE-SCHEMA.md §2). No Redis side effects here — those only fire once the
// caller's transaction actually commits, which only the transaction owner can know for sure.
export async function creditInTransaction(
  trx: Transaction<DB>,
  params: CreditParams,
): Promise<LedgerResult & { regionId: string | null; mintedAmount: number; revenueUsd: number }> {
  assertPositiveInteger(params.amount, 'Credit amount');
  const bucket = params.bucket ?? 'available';
  if (bucket === 'pending' && !params.holdUntil) {
    throw new AppError(
      'INVALID_HOLD',
      'holdUntil is required when crediting to the pending bucket',
      400,
    );
  }

  const wallet = await trx
    .selectFrom('wallets')
    .selectAll()
    .where('user_id', '=', params.userId)
    .forUpdate()
    .executeTakeFirst();
  if (!wallet) {
    throw new AppError('WALLET_NOT_FOUND', `No wallet for user ${params.userId}`, 404);
  }

  const deduped = await findDeduped(trx, params.idempotencyKey);
  if (deduped) {
    return { ...deduped, regionId: null, mintedAmount: 0, revenueUsd: 0 };
  }

  // Moved above the credit so the mint-pause check can see the region. Also feeds the return value,
  // which the caller uses to fire the I6 counters after commit.
  const user = await trx
    .selectFrom('users')
    .select('region_id')
    .where('id', '=', params.userId)
    .executeTakeFirst();

  if (UNBACKED_ENTRY_TYPES.includes(params.entryType)) {
    // Superadmin-configured auth rewards may intentionally exceed the generic free-coin cap. Their
    // partial unique indexes limit them to one of each per account; they still count in the rolling
    // total, so recurring free rewards remain blocked until the account is below the cap again.
    if (!ONE_TIME_AUTH_REWARD_TYPES.includes(params.entryType)) {
      await enforceUnbackedCap(trx, params.userId, params.amount);
    }
    // Kill-switch (01-COIN-ECONOMY.md §5), unbacked only. Backed credits come from network
    // postbacks: rejecting one makes the network retry forever and eventually drop revenue we have
    // already earned. Unbacked coin is exactly what drags the backing ratio down, so pausing it is
    // both safe and the point.
    if (user?.region_id && (await isMintPausedInTx(trx, user.region_id))) {
      throw new AppError('MINT_PAUSED', 'Free-coin earning is paused, please try again later', 429);
    }
  }

  const availableCoin = BigInt(wallet.available_coin);
  const balanceAfter =
    bucket === 'available' ? availableCoin + BigInt(params.amount) : availableCoin;

  const ledgerId = uuidv7();
  await trx
    .insertInto('coin_ledger')
    .values({
      id: ledgerId,
      user_id: params.userId,
      entry_type: params.entryType,
      amount: params.amount,
      bucket,
      ref_type: params.refType ?? null,
      ref_id: params.refId ?? null,
      balance_after: balanceAfter.toString(),
      idempotency_key: params.idempotencyKey ?? null,
      note: params.note ?? null,
      hold_until: params.holdUntil ?? null,
    })
    .execute();

  await trx
    .updateTable('wallets')
    .set((eb) => ({
      available_coin:
        bucket === 'available'
          ? eb('available_coin', '+', params.amount.toString())
          : eb.ref('available_coin'),
      pending_coin:
        bucket === 'pending'
          ? eb('pending_coin', '+', params.amount.toString())
          : eb.ref('pending_coin'),
      lifetime_earned: eb('lifetime_earned', '+', params.amount.toString()),
      updated_at: new Date(),
    }))
    .where('user_id', '=', params.userId)
    .execute();

  return {
    ledgerId,
    balanceAfter: balanceAfter.toString(),
    deduped: false,
    regionId: user?.region_id ?? null,
    mintedAmount: params.amount,
    revenueUsd: params.revenueUsd ?? 0,
  };
}

// Standalone convenience wrapper: opens its own transaction and, once it commits, fires the I6
// counters (best-effort — a lagging analytics counter must never fail a real credit).
export async function credit(params: CreditParams): Promise<LedgerResult> {
  const result = await db.transaction().execute((trx) => creditInTransaction(trx, params));
  if (result.regionId) {
    void recordMint(result.regionId, result.mintedAmount).catch(() => undefined);
    void recordRevenue(result.regionId, result.revenueUsd).catch(() => undefined);
  }
  return { ledgerId: result.ledgerId, balanceAfter: result.balanceAfter, deduped: result.deduped };
}

export async function creditPending(
  params: Omit<CreditParams, 'bucket'> & { holdUntil: Date },
): Promise<LedgerResult> {
  return credit({ ...params, bucket: 'pending' });
}

export async function debitInTransaction(
  trx: Transaction<DB>,
  params: DebitParams,
): Promise<LedgerResult> {
  assertPositiveInteger(params.amount, 'Debit amount');
  const bucket = params.bucket ?? 'available';

  const wallet = await trx
    .selectFrom('wallets')
    .selectAll()
    .where('user_id', '=', params.userId)
    .forUpdate()
    .executeTakeFirst();
  if (!wallet) {
    throw new AppError('WALLET_NOT_FOUND', `No wallet for user ${params.userId}`, 404);
  }

  const deduped = await findDeduped(trx, params.idempotencyKey);
  if (deduped) return deduped;

  const currentBucketBalance = BigInt(
    bucket === 'available' ? wallet.available_coin : wallet.pending_coin,
  );
  if (!params.allowNegative && currentBucketBalance < BigInt(params.amount)) {
    throw new AppError(
      'INSUFFICIENT_BALANCE',
      `User ${params.userId} does not have enough ${bucket} coin`,
      400,
    );
  }

  const availableCoin = BigInt(wallet.available_coin);
  const balanceAfter =
    bucket === 'available' ? availableCoin - BigInt(params.amount) : availableCoin;

  const ledgerId = uuidv7();
  await trx
    .insertInto('coin_ledger')
    .values({
      id: ledgerId,
      user_id: params.userId,
      entry_type: params.entryType,
      amount: -params.amount,
      bucket,
      ref_type: params.refType ?? null,
      ref_id: params.refId ?? null,
      balance_after: balanceAfter.toString(),
      idempotency_key: params.idempotencyKey ?? null,
      note: params.note ?? null,
    })
    .execute();

  await trx
    .updateTable('wallets')
    .set((eb) => ({
      available_coin:
        bucket === 'available'
          ? eb('available_coin', '-', params.amount.toString())
          : eb.ref('available_coin'),
      pending_coin:
        bucket === 'pending'
          ? eb('pending_coin', '-', params.amount.toString())
          : eb.ref('pending_coin'),
      // lifetime_redeemed only makes sense for redemption debits; other debit types (clawback, spin
      // ticket) leave it untouched. Redemption Core (later milestone) is the only real caller of this.
      lifetime_redeemed:
        bucket === 'available' && params.entryType === 'REDEMPTION_DEBIT'
          ? eb('lifetime_redeemed', '+', params.amount.toString())
          : eb.ref('lifetime_redeemed'),
      updated_at: new Date(),
    }))
    .where('user_id', '=', params.userId)
    .execute();

  return { ledgerId, balanceAfter: balanceAfter.toString(), deduped: false };
}

export async function debit(params: DebitParams): Promise<LedgerResult> {
  return db.transaction().execute((trx) => debitInTransaction(trx, params));
}

// HOLD_RELEASE (01-COIN-ECONOMY.md §4, 02-DATABASE-SCHEMA.md §2): moves a pending entry to available
// via two new ledger rows (chosen over mutating the original entry, for auditability), then clears
// hold_until on the original row so it drops out of coin_ledger_pending_hold_idx and the job never
// reprocesses it. The original row's bucket/amount are never touched — the ledger stays append-only.
export async function releaseHold(pendingEntryId: string): Promise<{ released: boolean }> {
  return db.transaction().execute(async (trx) => {
    const entry = await trx
      .selectFrom('coin_ledger')
      .selectAll()
      .where('id', '=', pendingEntryId)
      .forUpdate()
      .executeTakeFirst();
    if (entry?.bucket !== 'pending' || entry.hold_until === null) {
      return { released: false };
    }

    // A suspended or banned account keeps its held coin pending — hold_until stays set, so the
    // sweep picks it up again once the account is reinstated.
    const owner = await trx
      .selectFrom('users')
      .select('status')
      .where('id', '=', entry.user_id)
      .executeTakeFirst();
    if (owner?.status !== 'active') {
      return { released: false };
    }

    const wallet = await trx
      .selectFrom('wallets')
      .selectAll()
      .where('user_id', '=', entry.user_id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    const amount = Number(entry.amount);
    const availableCoin = BigInt(wallet.available_coin);
    const releasedAvailableBalance = availableCoin + BigInt(amount);

    await trx
      .insertInto('coin_ledger')
      .values([
        {
          id: uuidv7(),
          user_id: entry.user_id,
          entry_type: 'HOLD_RELEASE',
          amount: -amount,
          bucket: 'pending',
          ref_type: 'coin_ledger',
          ref_id: entry.id,
          balance_after: availableCoin.toString(),
          note: 'hold released to available',
        },
        {
          id: uuidv7(),
          user_id: entry.user_id,
          entry_type: 'HOLD_RELEASE',
          amount,
          bucket: 'available',
          ref_type: 'coin_ledger',
          ref_id: entry.id,
          balance_after: releasedAvailableBalance.toString(),
          note: 'hold released to available',
        },
      ])
      .execute();

    await trx
      .updateTable('wallets')
      .set((eb) => ({
        pending_coin: eb('pending_coin', '-', amount.toString()),
        available_coin: eb('available_coin', '+', amount.toString()),
        updated_at: new Date(),
      }))
      .where('user_id', '=', entry.user_id)
      .execute();

    await trx
      .updateTable('coin_ledger')
      .set({ hold_until: null })
      .where('id', '=', entry.id)
      .execute();

    return { released: true };
  });
}
