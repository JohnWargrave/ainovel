import { uuidv7 } from 'uuidv7';
import type { Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { recomputeScoreInTx } from './score.service.js';
import type {
  FraudFlag,
  FraudFlagListQuery,
  FraudFlagListResponse,
  FraudFlagReviewResponse,
} from './schemas.js';

const DEFAULT_LIMIT = 50;

export interface AdminActor {
  id: string;
  role: string;
}

interface FlagRow {
  id: string;
  user_id: string;
  rule_code: string;
  severity: number;
  evidence: unknown;
  status: string;
  created_at: Date;
  user_status: string;
  trust_level: number;
  fraud_score: number;
  region_id: string;
}

function serialize(row: FlagRow): FraudFlag {
  return {
    id: row.id,
    user_id: row.user_id,
    rule_code: row.rule_code,
    severity: row.severity,
    evidence: row.evidence ?? {},
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    user: {
      status: row.user_status,
      trust_level: row.trust_level,
      fraud_score: row.fraud_score,
      region_id: row.region_id,
    },
  };
}

const FLAG_COLUMNS = [
  'fraud_flags.id as id',
  'fraud_flags.user_id as user_id',
  'fraud_flags.rule_code as rule_code',
  'fraud_flags.severity as severity',
  'fraud_flags.evidence as evidence',
  'fraud_flags.status as status',
  'fraud_flags.created_at as created_at',
  'users.status as user_status',
  'users.trust_level as trust_level',
  'users.fraud_score as fraud_score',
  'users.region_id as region_id',
] as const;

export async function listFraudFlags(query: FraudFlagListQuery): Promise<FraudFlagListResponse> {
  const limit = query.limit ?? DEFAULT_LIMIT;

  let builder = db
    .selectFrom('fraud_flags')
    .innerJoin('users', 'users.id', 'fraud_flags.user_id')
    .select(FLAG_COLUMNS)
    // uuidv7 ids sort chronologically, so newest-first ordering and the cursor are the same column.
    .orderBy('fraud_flags.id', 'desc')
    .limit(limit + 1);

  if (query.status) builder = builder.where('fraud_flags.status', '=', query.status);
  if (query.user_id) builder = builder.where('fraud_flags.user_id', '=', query.user_id);
  if (query.rule_code) builder = builder.where('fraud_flags.rule_code', '=', query.rule_code);
  if (query.cursor) builder = builder.where('fraud_flags.id', '<', query.cursor);

  const rows = await builder.execute();
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => serialize(row)),
    next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

async function loadFlag(trx: Transaction<DB>, flagId: string): Promise<FlagRow> {
  const row = await trx
    .selectFrom('fraud_flags')
    .innerJoin('users', 'users.id', 'fraud_flags.user_id')
    .select(FLAG_COLUMNS)
    .where('fraud_flags.id', '=', flagId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError('NOT_FOUND', 'Fraud flag not found', 404);
  }
  return row;
}

// Both statuses are terminal for the review queue, but only `dismissed` removes the flag from the
// score (see recomputeScoreInTx) — confirming says "the signal was real", so the points must stay.
// Confirming a flag also stops ensureOpenFraudFlag() from deduping against it, which is what lets a
// repeat offence raise a fresh flag instead of silently folding into the old one.
async function reviewFlag(
  flagId: string,
  actor: AdminActor,
  nextStatus: 'dismissed' | 'confirmed',
  action: string,
  note?: string,
): Promise<FraudFlagReviewResponse> {
  return db.transaction().execute(async (trx) => {
    const flag = await loadFlag(trx, flagId);
    if (flag.status !== 'open') {
      throw new AppError('FLAG_ALREADY_REVIEWED', 'Fraud flag has already been reviewed', 409);
    }

    await trx
      .updateTable('fraud_flags')
      .set({ status: nextStatus })
      .where('id', '=', flagId)
      .where('status', '=', 'open')
      .execute();

    await trx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: actor.id,
        action,
        target_type: 'fraud_flag',
        target_id: flagId,
        detail: JSON.stringify({
          user_id: flag.user_id,
          rule_code: flag.rule_code,
          severity: flag.severity,
          note: note ?? null,
        }),
        ip: null,
      })
      .execute();

    // Closing a flag is the only way a fraud score ever goes down — without this the user stays at
    // the score that got them auto-suspended forever.
    const score = await recomputeScoreInTx(trx, flag.user_id);

    return {
      flag: serialize({ ...flag, status: nextStatus, fraud_score: score.score }),
      fraud_score: score.score,
      tier: score.tier,
    };
  });
}

export async function dismissFraudFlag(
  flagId: string,
  actor: AdminActor,
  note?: string,
): Promise<FraudFlagReviewResponse> {
  return reviewFlag(flagId, actor, 'dismissed', 'FRAUD_FLAG_DISMISSED', note);
}

export async function confirmFraudFlag(
  flagId: string,
  actor: AdminActor,
  note?: string,
): Promise<FraudFlagReviewResponse> {
  return reviewFlag(flagId, actor, 'confirmed', 'FRAUD_FLAG_CONFIRMED', note);
}
