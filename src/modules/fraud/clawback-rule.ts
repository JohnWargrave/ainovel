import { uuidv7 } from 'uuidv7';
import { db } from '../../db/index.js';

const MIN_EVENTS = 5;
const CLAWBACK_RATE_THRESHOLD = 0.15; // 05-FRAUD-ENGINE.md E01
const REFLAG_COOLDOWN_MS = 24 * 60 * 60 * 1000; // avoid re-flagging every single event once over the line

// E01 (05-FRAUD-ENGINE.md §1): clawback rate > 15% across at least 5 events lowers trust / flags for
// review. Window is the user's whole earning_events history rather than a rolling period — the spec
// doesn't name a window, and "overall clawback rate" is the simplest reading; can be narrowed later.
export async function evaluateClawbackRate(userId: string): Promise<void> {
  const counts = await db
    .selectFrom('earning_events')
    .select((eb) => [
      eb.fn.countAll<string>().as('total'),
      eb.fn.count<string>('id').filterWhere('status', '=', 'clawed_back').as('clawed_back'),
    ])
    .where('user_id', '=', userId)
    .where('status', 'in', ['credited', 'clawed_back'])
    .executeTakeFirstOrThrow();

  const total = Number(counts.total);
  const clawedBack = Number(counts.clawed_back);
  if (total < MIN_EVENTS) return;

  const rate = clawedBack / total;
  if (rate <= CLAWBACK_RATE_THRESHOLD) return;

  const recentFlag = await db
    .selectFrom('fraud_flags')
    .select('id')
    .where('user_id', '=', userId)
    .where('rule_code', '=', 'E01')
    .where('status', '=', 'open')
    .where('created_at', '>=', new Date(Date.now() - REFLAG_COOLDOWN_MS))
    .executeTakeFirst();
  if (recentFlag) return;

  await db
    .insertInto('fraud_flags')
    .values({
      id: uuidv7(),
      user_id: userId,
      rule_code: 'E01',
      severity: 4,
      evidence: JSON.stringify({ total, clawed_back: clawedBack, rate }),
    })
    .execute();
}
