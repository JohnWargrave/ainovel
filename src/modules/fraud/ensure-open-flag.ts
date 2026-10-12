import { uuidv7 } from 'uuidv7';
import type { Transaction } from 'kysely';
import type { DB } from '../../db/types.js';

// Shared "insert a fraud flag unless one of the same rule_code is already open" primitive — used by
// every rule that dedupes on open-flag state (redemption's E02/R02, referral's RF01/RF02/RF04) instead
// of each module re-deriving the same open-flag check.
export async function ensureOpenFraudFlag(
  trx: Transaction<DB>,
  userId: string,
  ruleCode: string,
  severity: number,
  evidence: unknown,
): Promise<void> {
  const existing = await trx
    .selectFrom('fraud_flags')
    .select('id')
    .where('user_id', '=', userId)
    .where('rule_code', '=', ruleCode)
    .where('status', '=', 'open')
    .executeTakeFirst();
  if (existing) return;

  await trx
    .insertInto('fraud_flags')
    .values({
      id: uuidv7(),
      user_id: userId,
      rule_code: ruleCode,
      severity,
      evidence: JSON.stringify(evidence),
    })
    .execute();
}
