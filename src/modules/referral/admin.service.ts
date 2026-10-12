import { sql, type Transaction } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { recomputeScoreInTx } from '../fraud/score.service.js';
import { assignReferralCode } from './referral-code.js';
import { parseReferralFeature } from './region-feature.js';
import type {
  AdminReferralCodeUpdate,
  AdminReferralDetail,
  AdminReferralListQuery,
  AdminReferralListResponse,
  AdminReferralSettings,
  AdminReferralSettingsList,
  AdminReferralSettingsUpdate,
  AdminReferralSummary,
} from './admin-schemas.js';

const DEFAULT_LIST_LIMIT = 50;

export interface ReferralAdminActor {
  id: string;
  role: string;
}

interface SummaryRow {
  user_id: string;
  email: string | null;
  referral_code: string | null;
  region_id: string;
  status: string;
  total_referrals: string;
  qualified_referrals: string;
  total_earned_coin: string;
  pending_earned_coin: string;
  clawed_back_coin: string;
  referral_frozen: boolean;
  referral_blocked: boolean;
}

const SUMMARY_COLUMNS = [
  'users.id as user_id',
  'users.email as email',
  'users.referral_code as referral_code',
  'users.region_id as region_id',
  'users.status as status',
  sql<string>`(
    select count(*) from users referred
    where referred.referred_by = users.id
  )`.as('total_referrals'),
  sql<string>`(
    select count(*) from users referred
    where referred.referred_by = users.id and referred.referral_qualified_at is not null
  )`.as('qualified_referrals'),
  sql<string>`(
    select coalesce(sum(ledger.amount), 0) from coin_ledger ledger
    where ledger.user_id = users.id
      and ledger.entry_type in ('REFERRAL_CREDIT', 'REFERRAL_CLAWBACK')
  )`.as('total_earned_coin'),
  sql<string>`(
    select coalesce(sum(ledger.amount), 0) from coin_ledger ledger
    where ledger.user_id = users.id
      and ledger.entry_type = 'REFERRAL_CREDIT'
      and ledger.bucket = 'pending'
      and ledger.hold_until is not null
      and not exists (
        select 1 from coin_ledger clawback
        where clawback.user_id = ledger.user_id
          and clawback.entry_type = 'REFERRAL_CLAWBACK'
          and clawback.ref_type = ledger.ref_type
          and clawback.ref_id = ledger.ref_id
      )
  )`.as('pending_earned_coin'),
  sql<string>`(
    select coalesce(-sum(ledger.amount), 0) from coin_ledger ledger
    where ledger.user_id = users.id and ledger.entry_type = 'REFERRAL_CLAWBACK'
  )`.as('clawed_back_coin'),
  sql<boolean>`exists (
    select 1 from fraud_flags flag
    where flag.user_id = users.id and flag.rule_code in ('RF02', 'RF03') and flag.status = 'open'
  )`.as('referral_frozen'),
  sql<boolean>`exists (
    select 1 from fraud_flags flag
    where flag.user_id = users.id and flag.rule_code = 'RF04' and flag.status = 'open'
  )`.as('referral_blocked'),
] as const;

function serializeSummary(row: SummaryRow): AdminReferralSummary {
  const total = Number(row.total_referrals);
  const qualified = Number(row.qualified_referrals);
  const earned = BigInt(row.total_earned_coin);
  const pending = BigInt(row.pending_earned_coin);
  return {
    user_id: row.user_id,
    email: row.email,
    referral_code: row.referral_code,
    region_id: row.region_id,
    status: row.status,
    total_referrals: total,
    qualified_referrals: qualified,
    pending_referrals: total - qualified,
    total_earned_coin: earned.toString(),
    available_earned_coin: (earned - pending).toString(),
    pending_earned_coin: pending.toString(),
    clawed_back_coin: row.clawed_back_coin,
    referral_frozen: row.referral_frozen,
    referral_blocked: row.referral_blocked,
  };
}

export async function listReferralSettings(): Promise<AdminReferralSettingsList> {
  const rows = await db
    .selectFrom('region_config')
    .select(['region_id', 'features', 'updated_at'])
    .orderBy('region_id', 'asc')
    .execute();
  return {
    items: rows.map((row) => serializeSettings(row.region_id, row.features, row.updated_at)),
  };
}

function serializeSettings(
  regionId: string,
  features: unknown,
  updatedAt: Date,
): AdminReferralSettings {
  const referral = parseReferralFeature(features);
  return {
    region_id: regionId,
    enabled: referral.enabled,
    reward_pct: referral.pct,
    duration_months: referral.duration_months,
    milestone_bonus_coin: referral.milestone_bonus_coin,
    milestone_bonus_threshold: referral.milestone_bonus_threshold,
    hold_hours: referral.hold_hours,
    credit_immediately: referral.credit_immediately,
    updated_at: new Date(updatedAt).toISOString(),
  };
}

export async function updateReferralSettings(
  regionId: string,
  input: AdminReferralSettingsUpdate,
  actor: ReferralAdminActor,
): Promise<AdminReferralSettings> {
  return db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('region_config')
      .select(['features', 'updated_at'])
      .where('region_id', '=', regionId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError('NOT_FOUND', 'Region config not found', 404);

    const features = asFeatureMap(before.features);
    const previous = parseReferralFeature(features);
    const referral = {
      enabled: input.enabled,
      pct: input.reward_pct,
      duration_months: input.duration_months,
      milestone_bonus_coin: input.milestone_bonus_coin,
      milestone_bonus_threshold: input.milestone_bonus_threshold,
      hold_hours: input.hold_hours,
      credit_immediately: input.credit_immediately,
    };
    const updatedAt = new Date();
    await trx
      .updateTable('region_config')
      .set({ features: JSON.stringify({ ...features, referral }), updated_at: updatedAt })
      .where('region_id', '=', regionId)
      .execute();
    await writeAudit(trx, actor, 'REFERRAL_SETTINGS_UPDATED', null, {
      region_id: regionId,
      before: previous,
      after: referral,
    });
    return serializeSettings(regionId, { referral }, updatedAt);
  });
}

function asFeatureMap(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function listAdminReferrals(
  query: AdminReferralListQuery,
): Promise<AdminReferralListResponse> {
  const limit = query.limit ?? DEFAULT_LIST_LIMIT;
  let builder = db
    .selectFrom('users')
    .select(SUMMARY_COLUMNS)
    .orderBy('users.id', 'desc')
    .limit(limit + 1);

  if (query.q) {
    const pattern = `%${query.q}%`;
    builder = builder.where((eb) =>
      eb.or([
        sql<boolean>`users.id::text ilike ${pattern}`,
        eb('users.email', 'ilike', pattern),
        eb('users.referral_code', 'ilike', pattern),
        sql<boolean>`exists (
          select 1 from password_credentials credential
          where credential.user_id = users.id and credential.username ilike ${pattern}
        )`,
      ]),
    );
  }
  if (query.region_id) builder = builder.where('users.region_id', '=', query.region_id);
  if (query.cursor) builder = builder.where('users.id', '<', query.cursor);

  const rows = (await builder.execute()) as SummaryRow[];
  const page = rows.slice(0, limit);
  return {
    items: page.map(serializeSummary),
    next_cursor: rows.length > limit ? (page[page.length - 1]?.user_id ?? null) : null,
  };
}

const USER_COLUMNS = [
  'id',
  'email',
  'referral_code',
  'region_id',
  'status',
  'referral_qualified_at',
  'referred_by_set_at',
  'created_at',
] as const;

function serializeUser(row: {
  id: string;
  email: string | null;
  referral_code: string | null;
  region_id: string;
  status: string;
  referral_qualified_at: Date | null;
  referred_by_set_at: Date | null;
  created_at: Date;
}): AdminReferralDetail['user'] {
  return {
    ...row,
    referral_qualified_at: row.referral_qualified_at?.toISOString() ?? null,
    referred_by_set_at: row.referred_by_set_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

export async function getAdminReferralDetail(userId: string): Promise<AdminReferralDetail> {
  const user = await db
    .selectFrom('users')
    .select([...USER_COLUMNS, 'referred_by'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);

  const [summaryRow, referrer, referredUsers, recentEarnings] = await Promise.all([
    db
      .selectFrom('users')
      .select(SUMMARY_COLUMNS)
      .where('users.id', '=', userId)
      .executeTakeFirstOrThrow(),
    user.referred_by
      ? db
          .selectFrom('users')
          .select(USER_COLUMNS)
          .where('id', '=', user.referred_by)
          .executeTakeFirst()
      : Promise.resolve(undefined),
    db
      .selectFrom('users')
      .select(USER_COLUMNS)
      .where('referred_by', '=', userId)
      .orderBy('id', 'desc')
      .limit(100)
      .execute(),
    db
      .selectFrom('coin_ledger')
      .select(['id', 'entry_type', 'amount', 'bucket', 'hold_until', 'ref_id', 'created_at'])
      .where('user_id', '=', userId)
      .where('entry_type', 'in', ['REFERRAL_CREDIT', 'REFERRAL_CLAWBACK'])
      .orderBy('id', 'desc')
      .limit(50)
      .execute(),
  ]);
  const clawedBackEventIds = new Set(
    recentEarnings
      .filter((entry) => entry.entry_type === 'REFERRAL_CLAWBACK' && entry.ref_id !== null)
      .map((entry) => entry.ref_id),
  );

  return {
    summary: serializeSummary(summaryRow),
    user: serializeUser(user),
    referrer: referrer ? serializeUser(referrer) : null,
    referred_users: referredUsers.map(serializeUser),
    recent_earnings: recentEarnings.map((entry) => ({
      id: entry.id,
      entry_type: entry.entry_type,
      amount: entry.amount,
      bucket: entry.bucket,
      state:
        entry.entry_type === 'REFERRAL_CLAWBACK' ||
        (entry.ref_id !== null && clawedBackEventIds.has(entry.ref_id))
          ? 'clawed_back'
          : entry.hold_until?.getUTCFullYear() === 2099
            ? 'frozen'
            : entry.hold_until
              ? 'pending'
              : 'available',
      hold_until: entry.hold_until?.toISOString() ?? null,
      source_event_id: entry.ref_id,
      created_at: entry.created_at.toISOString(),
    })),
  };
}

export async function updateReferralCode(
  userId: string,
  input: AdminReferralCodeUpdate,
  actor: ReferralAdminActor,
): Promise<AdminReferralDetail> {
  const code = input.code.trim().toUpperCase();
  await db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select(['id', 'referral_code'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);
    if (user.referral_code === code) return;
    const owner = await trx
      .selectFrom('users')
      .select('id')
      .where('referral_code', '=', code)
      .where('id', '!=', userId)
      .executeTakeFirst();
    if (owner) throw new AppError('REFERRAL_CODE_TAKEN', 'Referral code is already in use', 409);
    await trx.updateTable('users').set({ referral_code: code }).where('id', '=', userId).execute();
    await writeAudit(trx, actor, 'REFERRAL_CODE_UPDATED', userId, {
      before: user.referral_code,
      after: code,
      reason: input.reason,
    });
  });
  return getAdminReferralDetail(userId);
}

export async function regenerateReferralCode(
  userId: string,
  reason: string,
  actor: ReferralAdminActor,
): Promise<AdminReferralDetail> {
  await db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select(['id', 'referral_code'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);
    const code = await assignReferralCode(trx);
    await trx.updateTable('users').set({ referral_code: code }).where('id', '=', userId).execute();
    await writeAudit(trx, actor, 'REFERRAL_CODE_REGENERATED', userId, {
      before: user.referral_code,
      after: code,
      reason,
    });
  });
  return getAdminReferralDetail(userId);
}

export async function clearReferralFreeze(
  userId: string,
  reason: string,
  actor: ReferralAdminActor,
): Promise<AdminReferralDetail> {
  await db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('users')
      .innerJoin('region_config', 'region_config.region_id', 'users.region_id')
      .select(['users.id', 'region_config.features'])
      .where('users.id', '=', userId)
      .forUpdate('users')
      .executeTakeFirst();
    if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);

    const flags = await trx
      .selectFrom('fraud_flags')
      .select(['id', 'rule_code'])
      .where('user_id', '=', userId)
      .where('rule_code', 'in', ['RF02', 'RF03'])
      .where('status', '=', 'open')
      .execute();

    if (flags.length > 0) {
      await trx
        .updateTable('fraud_flags')
        .set({ status: 'dismissed' })
        .where(
          'id',
          'in',
          flags.map((flag) => flag.id),
        )
        .execute();
      await recomputeScoreInTx(trx, userId);
    }

    const frozenEntries = await trx
      .selectFrom('coin_ledger')
      .select(['id', 'ref_id', 'created_at'])
      .where('user_id', '=', userId)
      .where('entry_type', '=', 'REFERRAL_CREDIT')
      .where('bucket', '=', 'pending')
      .where('hold_until', '>=', new Date('2098-12-31T00:00:00Z'))
      .forUpdate()
      .execute();
    const feature = parseReferralFeature(user.features);
    const now = new Date();

    for (const entry of frozenEntries) {
      const source = entry.ref_id
        ? await trx
            .selectFrom('coin_ledger')
            .select('hold_until')
            .where('ref_type', '=', 'earning_event')
            .where('ref_id', '=', entry.ref_id)
            .where('entry_type', 'in', ['OFFERWALL_CREDIT', 'REWARDED_AD_CREDIT'])
            .executeTakeFirst()
        : undefined;
      const configuredRelease = new Date(
        entry.created_at.getTime() + feature.hold_hours * 60 * 60 * 1000,
      );
      const releaseAt = feature.credit_immediately
        ? now
        : [now, configuredRelease, source?.hold_until ?? now].reduce((latest, date) =>
            date > latest ? date : latest,
          );
      await trx
        .updateTable('coin_ledger')
        .set({ hold_until: releaseAt })
        .where('id', '=', entry.id)
        .execute();
    }

    await writeAudit(trx, actor, 'REFERRAL_FREEZE_CLEARED', userId, {
      reason,
      dismissed_flags: flags.map((flag) => ({ id: flag.id, rule_code: flag.rule_code })),
      rescheduled_credits: frozenEntries.length,
    });
  });
  return getAdminReferralDetail(userId);
}

async function writeAudit(
  trx: Transaction<DB>,
  actor: ReferralAdminActor,
  action: string,
  targetId: string | null,
  detail: unknown,
): Promise<void> {
  await trx
    .insertInto('audit_log')
    .values({
      id: uuidv7(),
      admin_user_id: actor.id,
      action,
      target_type: targetId ? 'user' : 'region_config',
      target_id: targetId,
      detail: JSON.stringify(detail),
      ip: null,
    })
    .execute();
}
