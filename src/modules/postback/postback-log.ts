import { uuidv7 } from 'uuidv7';
import { db } from '../../db/index.js';

// Shared by both the generic /postback/:network pipeline (postback.service.ts) and the AdMob SSV
// pipeline (rewarded-ads/ssv.service.ts) — both write to the same postback_logs table.
export async function logRawRequest(
  network: string,
  ip: string,
  query: Record<string, unknown>,
): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('postback_logs')
    .values({
      id,
      network,
      remote_ip: ip,
      query_params: JSON.stringify(query),
      verdict: 'error',
      earning_event_id: null,
    })
    .execute();
  return id;
}

export async function setVerdict(
  logId: string,
  verdict: string,
  earningEventId?: string,
): Promise<void> {
  await db
    .updateTable('postback_logs')
    .set({ verdict, earning_event_id: earningEventId ?? null })
    .where('id', '=', logId)
    .execute();
}
