import { uuidv7 } from 'uuidv7';
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../db/types.js';

export interface ActiveBoost {
  multiplier: number;
  expires_at: string;
}

// The boost prize's value in spin_config: "<multiplier>x<minutes>", e.g. "2x60" = ×2 for an hour.
const BOOST_VALUE = /^([2-9]|10)x([1-9]\d{0,3})$/;
const MAX_BOOST_MINUTES = 1440;

export function parseBoostValue(value: string): { multiplier: number; minutes: number } | null {
  const match = BOOST_VALUE.exec(value);
  if (!match) return null;
  const multiplier = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > MAX_BOOST_MINUTES) return null;
  return { multiplier, minutes };
}

export async function activeBoost(
  executor: Kysely<DB> | Transaction<DB>,
  userId: string,
  now = new Date(),
): Promise<ActiveBoost | null> {
  const row = await executor
    .selectFrom('user_boosts')
    .select(['multiplier', 'expires_at'])
    .where('user_id', '=', userId)
    .where('starts_at', '<=', now)
    .where('expires_at', '>', now)
    .orderBy('multiplier', 'desc')
    .orderBy('expires_at', 'desc')
    .executeTakeFirst();
  if (!row) return null;
  return { multiplier: row.multiplier, expires_at: new Date(row.expires_at).toISOString() };
}

/**
 * Queues the boost behind any the user already has running, so winning twice extends the window
 * rather than wasting the second prize on an overlap. Callers hold the user's wallet lock, which
 * serializes concurrent grants.
 */
export async function grantBoostInTransaction(
  trx: Transaction<DB>,
  params: {
    userId: string;
    multiplier: number;
    minutes: number;
    source: string;
    sourceId: string;
    now?: Date;
  },
): Promise<ActiveBoost> {
  const now = params.now ?? new Date();
  const latest = await trx
    .selectFrom('user_boosts')
    .select('expires_at')
    .where('user_id', '=', params.userId)
    .where('expires_at', '>', now)
    .orderBy('expires_at', 'desc')
    .executeTakeFirst();
  const startsAt = latest ? new Date(latest.expires_at) : now;
  const expiresAt = new Date(startsAt.getTime() + params.minutes * 60_000);
  await trx
    .insertInto('user_boosts')
    .values({
      id: uuidv7(),
      user_id: params.userId,
      multiplier: params.multiplier,
      starts_at: startsAt,
      expires_at: expiresAt,
      source: params.source,
      source_id: params.sourceId,
    })
    .execute();
  return { multiplier: params.multiplier, expires_at: expiresAt.toISOString() };
}
