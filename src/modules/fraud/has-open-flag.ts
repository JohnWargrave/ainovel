import { db } from '../../db/index.js';

export async function hasOpenFraudFlag(
  userId: string,
  ruleCodes: readonly string[],
): Promise<boolean> {
  const row = await db
    .selectFrom('fraud_flags')
    .select('id')
    .where('user_id', '=', userId)
    .where('rule_code', 'in', ruleCodes)
    .where('status', '=', 'open')
    .executeTakeFirst();
  return row !== undefined;
}
