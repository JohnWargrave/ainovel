import { uuidv7 } from 'uuidv7';
import type { Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';

const DECAY_WINDOW_DAYS = 30;
const RED_THRESHOLD = 70;
const YELLOW_THRESHOLD = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type FraudTier = 'green' | 'yellow' | 'red';

export interface ScoreResult {
  score: number;
  tier: FraudTier;
}

function tierFor(score: number): FraudTier {
  if (score >= RED_THRESHOLD) return 'red';
  if (score >= YELLOW_THRESHOLD) return 'yellow';
  return 'green';
}

// 05-FRAUD-ENGINE.md §3 calls for "weighted severity + time decay" but doesn't give an exact formula
// — this is the v1 baseline: each open flag contributes severity*10 points, decaying linearly to 0
// over 30 days. A single severity-4 flag lands at 40 (yellow), not red, so one weak signal alone
// never soft-bans a user; it takes either a severity-5 flag plus another, or repeated flags.
export function computeScore(
  flags: readonly { severity: number; created_at: Date }[],
  now: Date,
): number {
  const total = flags.reduce((sum, flag) => {
    const ageDays = (now.getTime() - flag.created_at.getTime()) / MS_PER_DAY;
    const decay = Math.max(0, 1 - ageDays / DECAY_WINDOW_DAYS);
    return sum + flag.severity * 10 * decay;
  }, 0);
  return Math.min(100, Math.round(total));
}

// Single point where a score result turns into an action (05-FRAUD-ENGINE.md §4) — every rule that
// writes a fraud_flags row calls back through recomputeScore(InTx) instead of deciding its own action,
// so soft-ban only ever happens here. Idempotent: only suspends a user who is currently 'active',
// so re-running against an already-suspended/banned user is a no-op (no duplicate audit_log row).
async function applyScore(
  trx: Transaction<DB>,
  userId: string,
  score: number,
  tier: FraudTier,
): Promise<void> {
  await trx.updateTable('users').set({ fraud_score: score }).where('id', '=', userId).execute();
  if (tier !== 'red') return;

  const user = await trx
    .selectFrom('users')
    .select('status')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (user?.status !== 'active') return;

  await trx
    .updateTable('users')
    .set({ status: 'suspended' })
    .where('id', '=', userId)
    .where('status', '=', 'active')
    .execute();

  // User-facing message stays generic (05§6) — this detail is for admin/audit eyes only.
  await trx
    .insertInto('audit_log')
    .values({
      id: uuidv7(),
      admin_user_id: null,
      action: 'AUTO_FRAUD_SUSPEND',
      target_type: 'user',
      target_id: userId,
      detail: JSON.stringify({ score, tier }),
      ip: null,
    })
    .execute();
}

export async function recomputeScoreInTx(
  trx: Transaction<DB>,
  userId: string,
): Promise<ScoreResult> {
  // 'open' = not reviewed yet, 'confirmed' = a reviewer looked and the signal was real — both keep
  // scoring (the 30-day decay in computeScore ages them out on its own). Only 'dismissed' stops
  // counting, which makes dismissal the single lever that lowers a score.
  const flags = await trx
    .selectFrom('fraud_flags')
    .select(['severity', 'created_at'])
    .where('user_id', '=', userId)
    .where('status', 'in', ['open', 'confirmed'])
    .execute();

  const now = new Date();
  const score = computeScore(
    flags.map((f) => ({ severity: f.severity, created_at: new Date(f.created_at) })),
    now,
  );
  const tier = tierFor(score);
  await applyScore(trx, userId, score, tier);
  return { score, tier };
}

export async function recomputeScore(userId: string): Promise<ScoreResult> {
  return db.transaction().execute((trx) => recomputeScoreInTx(trx, userId));
}
