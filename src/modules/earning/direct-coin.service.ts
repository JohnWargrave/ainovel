import type { Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { creditInTransaction } from '../wallet-ledger/ledger.service.js';
import { recordMint } from '../wallet-ledger/economy-counters.js';

const SETTINGS_ID = 'global';

export interface DirectCoinSettings {
  enabled: boolean;
  max_amount_coin: number;
  updated_at: Date;
}

export interface DirectCoinGrantResult {
  amount_coin: number;
  new_balance: string;
  deduped: boolean;
}

export async function getDirectCoinSettings(): Promise<DirectCoinSettings> {
  return db
    .selectFrom('direct_coin_settings')
    .select(['enabled', 'max_amount_coin', 'updated_at'])
    .where('id', '=', SETTINGS_ID)
    .executeTakeFirstOrThrow();
}

function getDirectCoinSettingsInTransaction(trx: Transaction<DB>): Promise<DirectCoinSettings> {
  return trx
    .selectFrom('direct_coin_settings')
    .select(['enabled', 'max_amount_coin', 'updated_at'])
    .where('id', '=', SETTINGS_ID)
    .executeTakeFirstOrThrow();
}

// Same standing check the rewarded-ad and check-in paths apply. A banned account must not be able to
// mint through the one endpoint that skips every earning gate.
function assertEarningAllowed(status: string): void {
  if (status === 'banned') {
    throw new AppError('EARNING_BLOCKED', 'User is not in good standing to earn', 403);
  }
  if (status === 'suspended') {
    throw new AppError(
      'EARNING_SUSPENDED',
      'Earning is temporarily unavailable for this account',
      403,
    );
  }
}

/**
 * Credits a caller-supplied coin amount to the caller's own wallet.
 *
 * Unlike every other earning path, the amount here is not derived from anything the server can
 * verify — no ad impression, no signed postback, no config-driven reward table. The controls are
 * therefore all bounds rather than proofs: the CMS on/off switch, the per-request ceiling, the I2
 * rolling unbacked cap inside creditInTransaction, and the mint kill-switch. Treat the endpoint as
 * trusted-client-only and keep `enabled` false wherever the client is not trusted.
 */
export async function grantDirectCoin(
  userId: string,
  amountCoin: number,
  idempotencyKey: string | null,
): Promise<DirectCoinGrantResult> {
  const result = await db.transaction().execute(async (trx) => {
    // Read the switch inside the transaction so a grant cannot straddle an admin turning it off.
    const settings = await getDirectCoinSettingsInTransaction(trx);
    if (!settings.enabled) {
      throw new AppError('FEATURE_DISABLED', 'Direct coin credit is not enabled', 404);
    }
    if (amountCoin > settings.max_amount_coin) {
      throw new AppError(
        'AMOUNT_TOO_LARGE',
        `Amount exceeds the ${String(settings.max_amount_coin)} coin per-request limit`,
        400,
      );
    }

    const user = await trx
      .selectFrom('users')
      .select('status')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new AppError('USER_NOT_FOUND', `No user ${userId}`, 404);
    assertEarningAllowed(user.status);

    // Namespaced by user so one caller's key can never dedupe against another's, which would
    // silently swallow a legitimate credit. Spread rather than `: undefined` because
    // exactOptionalPropertyTypes distinguishes an absent key from one explicitly set to undefined,
    // and CreditParams means the former — no key at all, so every call is a fresh grant.
    const ledger = await creditInTransaction(trx, {
      userId,
      entryType: 'DIRECT_CREDIT',
      amount: amountCoin,
      ...(idempotencyKey ? { idempotencyKey: `direct-coin:${userId}:${idempotencyKey}` } : {}),
      note: 'Direct coin credit',
    });

    return ledger;
  });

  // Best-effort, post-commit, and only for a credit that actually happened — a deduped replay
  // returns mintedAmount 0 and must not be counted twice against the region's mint total.
  if (result.regionId && result.mintedAmount > 0) {
    void recordMint(result.regionId, result.mintedAmount).catch(() => undefined);
  }

  return {
    amount_coin: result.deduped ? 0 : amountCoin,
    new_balance: result.balanceAfter,
    deduped: result.deduped,
  };
}
