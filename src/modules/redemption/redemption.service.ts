import { sql, type Transaction } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { Value } from '@sinclair/typebox/value';
import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import type { DB, RedemptionStatus } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { checkSubjectRateLimit } from '../../lib/rate-limit.js';
import { ensureOpenFraudFlag } from '../fraud/ensure-open-flag.js';
import { recomputeScoreInTx } from '../fraud/score.service.js';
import { creditInTransaction, debitInTransaction } from '../wallet-ledger/ledger.service.js';
import { RedemptionRewardSchema } from './schemas.js';
import type {
  AdminRedemptionDetail,
  AdminRedemptionListQuery,
  AdminRedemptionSummary,
  RedemptionClaimState,
  RedemptionListQuery,
  RedemptionReward,
} from './schemas.js';

const REVIEW_ROLES = ['reviewer', 'superadmin'] as const;
const FULFILLMENT_ROLES = ['fulfillment', 'superadmin'] as const;
const ACTIVE_REDEMPTION_STATUSES: RedemptionStatus[] = [
  'REQUESTED',
  'FRAUD_REVIEW',
  'APPROVED',
  'PURCHASING',
  'DELIVERED',
];
const TERMINAL_STATUSES: RedemptionStatus[] = ['DELIVERED', 'REJECTED', 'FAILED'];
const CODE_RATE_LIMIT_WINDOW_S = 60 * 60;
const CODE_RATE_LIMIT_MAX = 5;
const FIRST_REDEMPTION_REVIEW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLAIM_HOLD_HOURS = 48;
const MAX_CLAIM_HOLD_HOURS = 720;

interface RedemptionRow {
  id: string;
  user_id: string;
  catalog_item_id: string;
  coin_price: string;
  usd_cost_est: string;
  status: RedemptionStatus;
  fraud_score_at_request: number | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  reject_reason: string | null;
  reward_snapshot: unknown;
  delivery_code: string | null;
  delivery_note: string | null;
  delivered_at: Date | null;
  claimed_at: Date | null;
  claimable_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface RedemptionResponse {
  id: string;
  status: RedemptionStatus;
  catalog_item_id: string;
  reward: RedemptionReward;
  coin_price: string;
  usd_cost_est: string;
  fraud_score_at_request: number | null;
  reject_reason: string | null;
  delivery_note: string | null;
  delivered_at: string | null;
  claimed_at: string | null;
  claim_state: RedemptionClaimState;
  claimable_at: string;
  seconds_until_claimable: number;
  can_claim_now: boolean;
  created_at: string;
  updated_at: string;
}

export interface RedemptionTimelineEntry {
  status: RedemptionStatus;
  actor: string;
  note: string | null;
  at: string;
}

export interface RedemptionDetailResponse extends RedemptionResponse {
  timeline: RedemptionTimelineEntry[];
}

export interface RedemptionListResponse {
  items: RedemptionResponse[];
  next_cursor: string | null;
}

export interface AdminRedemptionListResponse {
  items: AdminRedemptionSummary[];
  next_cursor: string | null;
}

export interface DeliveryCodeResponse {
  redemption_id: string;
  delivery_code: string;
  delivery_note: string | null;
}

interface AdminActor {
  id: string;
  role: string;
}

interface TransitionParams {
  redemptionId: string;
  expectedFrom: RedemptionStatus[];
  toStatus: RedemptionStatus;
  actor: string;
  adminUserId: string | null;
  note?: string | undefined;
  patch?: Partial<
    Pick<
      RedemptionRow,
      | 'reviewed_by'
      | 'reviewed_at'
      | 'reject_reason'
      | 'delivery_code'
      | 'delivery_note'
      | 'delivered_at'
    >
  >;
}

interface RedemptionFeatures {
  enabled?: boolean;
  weekly_cap_usd?: Record<string, number>;
  claim_hold_hours?: number;
  auto_approve_paused?: boolean;
}

interface RegionFeatures {
  redemption?: RedemptionFeatures;
}

function parseRewardSnapshot(value: unknown): RedemptionReward {
  if (!Value.Check(RedemptionRewardSchema, value)) {
    throw new AppError('REDEMPTION_DATA_INVALID', 'Redemption reward snapshot is invalid', 500);
  }
  return value;
}

// REJECTED/FAILED are reported ahead of `claimed_at` so a refunded order never reads as CLAIMED
// just because the user had already opened the code before it failed.
function deriveClaimState(row: RedemptionRow, now: Date): RedemptionClaimState {
  if (row.status === 'REJECTED') return 'REJECTED';
  if (row.status === 'FAILED') return 'FAILED';
  if (row.claimed_at) return 'CLAIMED';
  if (row.status === 'DELIVERED' && row.claimable_at.getTime() <= now.getTime()) return 'CLAIMABLE';
  return 'PENDING';
}

function serializeRedemption(row: RedemptionRow, now: Date = new Date()): RedemptionResponse {
  const claimState = deriveClaimState(row, now);
  return {
    id: row.id,
    status: row.status,
    catalog_item_id: row.catalog_item_id,
    reward: parseRewardSnapshot(row.reward_snapshot),
    coin_price: row.coin_price,
    usd_cost_est: row.usd_cost_est,
    fraud_score_at_request: row.fraud_score_at_request,
    reject_reason: row.reject_reason,
    delivery_note: row.delivery_note,
    delivered_at: row.delivered_at?.toISOString() ?? null,
    claimed_at: row.claimed_at?.toISOString() ?? null,
    claim_state: claimState,
    claimable_at: row.claimable_at.toISOString(),
    seconds_until_claimable: Math.max(
      0,
      Math.ceil((row.claimable_at.getTime() - now.getTime()) / 1000),
    ),
    can_claim_now: claimState === 'CLAIMABLE',
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// An out-of-range or missing value falls back to the default rather than throwing: a bad hold
// setting should not take the whole redemption flow down for the region.
function parseClaimHoldHours(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_CLAIM_HOLD_HOURS
    ? value
    : DEFAULT_CLAIM_HOLD_HOURS;
}

function parseRedemptionFeatures(
  features: unknown,
  trustLevel: number,
): { weeklyCapUsd: number; claimHoldHours: number } {
  const parsed = features as RegionFeatures;
  const redemption = parsed.redemption;
  if (!redemption?.enabled) {
    throw new AppError('FEATURE_DISABLED', 'Redemption is not enabled for this region', 404);
  }
  const weeklyCapUsd = redemption.weekly_cap_usd?.[String(trustLevel)];
  if (typeof weeklyCapUsd !== 'number' || weeklyCapUsd <= 0) {
    throw new AppError('REDEMPTION_CONFIG_MISSING', 'Redemption config is missing', 500);
  }
  return { weeklyCapUsd, claimHoldHours: parseClaimHoldHours(redemption.claim_hold_hours) };
}

function isAutoApprovalPaused(features: unknown): boolean {
  const economy = (features as { economy?: { auto_approve_paused?: unknown } }).economy;
  return economy?.auto_approve_paused === true;
}

async function insertAudit(
  trx: Transaction<DB>,
  params: {
    adminUserId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    detail: unknown;
    ip?: string | null;
  },
): Promise<void> {
  await trx
    .insertInto('audit_log')
    .values({
      id: uuidv7(),
      admin_user_id: params.adminUserId,
      action: params.action,
      target_type: params.targetType,
      target_id: params.targetId,
      detail: JSON.stringify(params.detail),
      ip: params.ip ?? null,
    })
    .execute();
}

async function insertHistory(
  trx: Transaction<DB>,
  params: {
    redemptionId: string;
    fromStatus: RedemptionStatus | null;
    toStatus: RedemptionStatus;
    actor: string;
    note?: string | undefined;
  },
): Promise<void> {
  await trx
    .insertInto('redemption_status_history')
    .values({
      id: uuidv7(),
      redemption_id: params.redemptionId,
      from_status: params.fromStatus,
      to_status: params.toStatus,
      actor: params.actor,
      note: params.note ?? null,
    })
    .execute();
}

async function transitionRedemption(
  trx: Transaction<DB>,
  params: TransitionParams,
): Promise<RedemptionRow> {
  const redemption = await trx
    .selectFrom('redemptions')
    .selectAll()
    .where('id', '=', params.redemptionId)
    .forUpdate()
    .executeTakeFirst();
  if (!redemption) {
    throw new AppError('REDEMPTION_NOT_FOUND', 'Redemption not found', 404);
  }
  if (!params.expectedFrom.includes(redemption.status)) {
    throw new AppError('INVALID_REDEMPTION_TRANSITION', 'Invalid redemption transition', 409);
  }
  if (TERMINAL_STATUSES.includes(redemption.status)) {
    throw new AppError('REDEMPTION_TERMINAL', 'Redemption is terminal', 409);
  }

  const patch = params.patch ?? {};
  await trx
    .updateTable('redemptions')
    .set({ ...patch, status: params.toStatus, updated_at: new Date() })
    .where('id', '=', params.redemptionId)
    .execute();

  await insertHistory(trx, {
    redemptionId: params.redemptionId,
    fromStatus: redemption.status,
    toStatus: params.toStatus,
    actor: params.actor,
    note: params.note,
  });
  await insertAudit(trx, {
    adminUserId: params.adminUserId,
    action: `REDEMPTION_${params.toStatus}`,
    targetType: 'redemption',
    targetId: params.redemptionId,
    detail: {
      from_status: redemption.status,
      to_status: params.toStatus,
      note: params.note ?? null,
    },
  });

  const updated = await trx
    .selectFrom('redemptions')
    .selectAll()
    .where('id', '=', params.redemptionId)
    .executeTakeFirstOrThrow();
  return updated;
}

async function refundRedemptionInTx(
  trx: Transaction<DB>,
  redemption: RedemptionRow,
): Promise<void> {
  const refund = await creditInTransaction(trx, {
    userId: redemption.user_id,
    entryType: 'REDEMPTION_REFUND',
    amount: Number(redemption.coin_price),
    bucket: 'available',
    refType: 'redemption',
    refId: redemption.id,
    idempotencyKey: `redemption:${redemption.id}:refund`,
    note: 'Redemption refund',
  });
  if (!refund.deduped) {
    await trx
      .updateTable('wallets')
      .set((eb) => ({
        lifetime_redeemed: eb('lifetime_redeemed', '-', redemption.coin_price),
        updated_at: new Date(),
      }))
      .where('user_id', '=', redemption.user_id)
      .execute();
  }
}

async function encryptedDeliveryCode(deliveryCode: string): Promise<string> {
  const encrypted = await db
    .selectNoFrom(() =>
      sql<string>`encode(pgp_sym_encrypt(${deliveryCode}, ${env.DELIVERY_CODE_ENC_KEY}), 'base64')`.as(
        'value',
      ),
    )
    .executeTakeFirstOrThrow();
  return encrypted.value;
}

async function decryptedDeliveryCode(deliveryCode: string): Promise<string> {
  const decrypted = await db
    .selectNoFrom(() =>
      sql<string>`pgp_sym_decrypt(decode(${deliveryCode}, 'base64'), ${env.DELIVERY_CODE_ENC_KEY})`.as(
        'value',
      ),
    )
    .executeTakeFirstOrThrow();
  return decrypted.value;
}

export async function createRedemption(
  userId: string,
  catalogItemId: string,
): Promise<RedemptionResponse> {
  return db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select(['id', 'country_code', 'region_id', 'trust_level', 'status', 'created_at'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) {
      throw new AppError('USER_NOT_FOUND', 'User not found', 404);
    }
    if (user.status === 'banned') {
      throw new AppError('REDEMPTION_BLOCKED', 'Redemption is blocked', 403);
    }
    if (user.status === 'suspended') {
      throw new AppError('REDEMPTION_SUSPENDED', 'Redemption is suspended', 403);
    }
    if (user.status !== 'active') {
      throw new AppError('REDEMPTION_BLOCKED', 'Redemption is blocked', 403);
    }

    const item = await trx
      .selectFrom('catalog_items')
      .select([
        'id',
        'sku',
        'title',
        'category',
        'face_value',
        'image_url',
        'coin_price',
        'usd_cost',
        'regions',
        'is_active',
      ])
      .where('id', '=', catalogItemId)
      .executeTakeFirst();
    if (!item?.is_active) {
      throw new AppError('CATALOG_ITEM_UNAVAILABLE', 'Catalog item is unavailable', 400);
    }
    if (!item.regions.includes(user.country_code) && !item.regions.includes(user.region_id)) {
      throw new AppError(
        'CATALOG_ITEM_UNAVAILABLE',
        'Catalog item is unavailable in this region',
        400,
      );
    }

    const regionConfig = await trx
      .selectFrom('region_config')
      .select('features')
      .where('region_id', '=', user.region_id)
      .executeTakeFirst();
    if (!regionConfig) {
      throw new AppError('REDEMPTION_CONFIG_MISSING', 'Redemption config is missing', 500);
    }
    const { weeklyCapUsd, claimHoldHours } = parseRedemptionFeatures(
      regionConfig.features,
      user.trust_level,
    );
    const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const weekly = await trx
      .selectFrom('redemptions')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('usd_cost_est'), eb.lit(0)).as('total'))
      .where('user_id', '=', userId)
      .where('status', 'in', ACTIVE_REDEMPTION_STATUSES)
      .where('created_at', '>=', weekStart)
      .executeTakeFirstOrThrow();
    if (Number(weekly.total) + Number(item.usd_cost) > weeklyCapUsd) {
      throw new AppError('REDEMPTION_WEEKLY_CAP', 'Weekly redemption cap exceeded', 400);
    }

    const priorRedemption = await trx
      .selectFrom('redemptions')
      .select('id')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const firstRedemptionReview =
      !priorRedemption &&
      Date.now() - new Date(user.created_at).getTime() < FIRST_REDEMPTION_REVIEW_MS;

    let scoreResult = await recomputeScoreInTx(trx, userId);
    if (firstRedemptionReview) {
      await ensureOpenFraudFlag(trx, userId, 'E02', 3, { reason: 'first_redemption_under_24h' });
      scoreResult = await recomputeScoreInTx(trx, userId);
    }
    const forceReject = scoreResult.score >= 90;
    if (forceReject) {
      await ensureOpenFraudFlag(trx, userId, 'R02', 5, { score: scoreResult.score });
      scoreResult = await recomputeScoreInTx(trx, userId);
    }

    const redemptionId = uuidv7();
    await debitInTransaction(trx, {
      userId,
      entryType: 'REDEMPTION_DEBIT',
      amount: Number(item.coin_price),
      bucket: 'available',
      refType: 'redemption',
      refId: redemptionId,
      idempotencyKey: `redemption:${redemptionId}:debit`,
      note: 'Redemption request',
    });

    await trx
      .insertInto('redemptions')
      .values({
        id: redemptionId,
        user_id: userId,
        catalog_item_id: catalogItemId,
        coin_price: item.coin_price,
        usd_cost_est: item.usd_cost,
        reward_snapshot: {
          sku: item.sku,
          title: item.title,
          category: item.category,
          face_value: item.face_value,
          image_url: item.image_url,
        },
        status: 'REQUESTED',
        fraud_score_at_request: scoreResult.score,
        // Counted from the request, not from fulfillment: the countdown the user is shown starts
        // when their coins leave the wallet and never stretches because fulfillment was slow.
        claimable_at: new Date(Date.now() + claimHoldHours * 60 * 60 * 1000),
      })
      .execute();
    await insertHistory(trx, {
      redemptionId,
      fromStatus: null,
      toStatus: 'REQUESTED',
      actor: 'user',
    });
    await insertAudit(trx, {
      adminUserId: null,
      action: 'REDEMPTION_REQUESTED',
      targetType: 'redemption',
      targetId: redemptionId,
      detail: { catalog_item_id: catalogItemId, fraud_score: scoreResult.score },
    });

    let row = await trx
      .selectFrom('redemptions')
      .selectAll()
      .where('id', '=', redemptionId)
      .executeTakeFirstOrThrow();

    if (forceReject) {
      await trx
        .updateTable('users')
        .set({ status: 'suspended' })
        .where('id', '=', userId)
        .where('status', '=', 'active')
        .execute();
      row = await transitionRedemption(trx, {
        redemptionId,
        expectedFrom: ['REQUESTED'],
        toStatus: 'REJECTED',
        actor: 'system',
        adminUserId: null,
        note: 'R02 auto-reject',
        patch: { reject_reason: 'Fraud review failed', reviewed_at: new Date() },
      });
      await refundRedemptionInTx(trx, row);
      return serializeRedemption(row);
    }

    const targetStatus: RedemptionStatus =
      scoreResult.score >= 30 ||
      firstRedemptionReview ||
      isAutoApprovalPaused(regionConfig.features)
        ? 'FRAUD_REVIEW'
        : 'APPROVED';
    row = await transitionRedemption(trx, {
      redemptionId,
      expectedFrom: ['REQUESTED'],
      toStatus: targetStatus,
      actor: 'system',
      adminUserId: null,
      note: targetStatus === 'FRAUD_REVIEW' ? 'Fraud review required' : 'Auto-approved',
    });
    return serializeRedemption(row);
  });
}

export async function listUserRedemptions(
  userId: string,
  query: RedemptionListQuery,
): Promise<RedemptionListResponse> {
  const limit = query.limit ?? 50;
  let builder = db
    .selectFrom('redemptions')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1);
  if (query.status) builder = builder.where('status', '=', query.status);
  if (query.cursor) builder = builder.where('id', '<', query.cursor);
  const rows = await builder.execute();
  const page = rows.slice(0, limit);
  // One clock for the whole page so two items with the same claimable_at cannot disagree about
  // whether the hold has elapsed.
  const now = new Date();
  return {
    items: page.map((row) => serializeRedemption(row, now)),
    next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

// Dedicated per-item endpoint rather than making the reward screen scan the paginated list: it is
// the one call a client polls while a hold is counting down.
export async function getUserRedemptionDetail(
  userId: string,
  redemptionId: string,
): Promise<RedemptionDetailResponse> {
  const row = await db
    .selectFrom('redemptions')
    .selectAll()
    .where('id', '=', redemptionId)
    .executeTakeFirst();
  // Not-owned is reported as not-found so the endpoint cannot be used to probe for valid ids.
  if (row?.user_id !== userId) {
    throw new AppError('REDEMPTION_NOT_FOUND', 'Redemption not found', 404);
  }
  const history = await db
    .selectFrom('redemption_status_history')
    .select(['to_status', 'actor', 'note', 'created_at'])
    .where('redemption_id', '=', redemptionId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return {
    ...serializeRedemption(row),
    timeline: history.map((entry) => ({
      status: entry.to_status,
      actor: entry.actor,
      note: entry.note,
      at: entry.created_at.toISOString(),
    })),
  };
}

export async function getDeliveryCode(
  userId: string,
  redemptionId: string,
): Promise<DeliveryCodeResponse> {
  await checkSubjectRateLimit(
    'redemption-code',
    `${userId}:${redemptionId}`,
    CODE_RATE_LIMIT_WINDOW_S,
    CODE_RATE_LIMIT_MAX,
  );
  const redemption = await db
    .selectFrom('redemptions')
    .select([
      'id',
      'user_id',
      'status',
      'delivery_code',
      'delivery_note',
      'claimed_at',
      'claimable_at',
    ])
    .where('id', '=', redemptionId)
    .executeTakeFirst();
  if (redemption?.user_id !== userId) {
    throw new AppError('REDEMPTION_NOT_FOUND', 'Redemption not found', 404);
  }
  if (redemption.status !== 'DELIVERED' || !redemption.delivery_code) {
    throw new AppError('DELIVERY_CODE_UNAVAILABLE', 'Delivery code is unavailable', 400);
  }
  // Enforced server-side rather than trusting the client to hide the button: the code is decrypted
  // below, so an early call must not get that far.
  const now = new Date();
  if (redemption.claimable_at.getTime() > now.getTime()) {
    // publicDetails, not details: the app renders a countdown from this, so it has to survive
    // serialization. See AppError in lib/errors.ts for the split.
    throw new AppError('REDEMPTION_HOLD_ACTIVE', 'Reward is not claimable yet', 409, undefined, {
      claimable_at: redemption.claimable_at.toISOString(),
    });
  }
  const deliveryCode = await decryptedDeliveryCode(redemption.delivery_code);
  await db.transaction().execute(async (trx) => {
    let claimedAt = redemption.claimed_at;
    if (!redemption.claimed_at) {
      const updated = await trx
        .updateTable('redemptions')
        .set({ claimed_at: new Date(), updated_at: new Date() })
        .where('id', '=', redemptionId)
        .where('claimed_at', 'is', null)
        .returning('claimed_at')
        .executeTakeFirst();
      claimedAt =
        updated?.claimed_at ??
        (
          await trx
            .selectFrom('redemptions')
            .select('claimed_at')
            .where('id', '=', redemptionId)
            .executeTakeFirstOrThrow()
        ).claimed_at;
    }
    if (!claimedAt) {
      throw new AppError('REDEMPTION_DATA_INVALID', 'Redemption claim timestamp is missing', 500);
    }
    await trx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: null,
        action: 'REDEMPTION_CODE_VIEW',
        target_type: 'redemption',
        target_id: redemptionId,
        detail: JSON.stringify({ user_id: userId, claimed_at: claimedAt.toISOString() }),
        ip: null,
      })
      .execute();
  });
  return {
    redemption_id: redemptionId,
    delivery_code: deliveryCode,
    delivery_note: redemption.delivery_note,
  };
}

export async function listAdminRedemptions(
  query: AdminRedemptionListQuery,
): Promise<AdminRedemptionListResponse> {
  const limit = query.limit ?? 50;
  let builder = db
    .selectFrom('redemptions as redemption')
    .innerJoin('users as user', 'user.id', 'redemption.user_id')
    .innerJoin('catalog_items as item', 'item.id', 'redemption.catalog_item_id')
    .selectAll('redemption')
    .select([
      'user.id as admin_user_id',
      'user.email as admin_user_email',
      'user.status as admin_user_status',
      'user.region_id as admin_user_region_id',
      'user.country_code as admin_user_country_code',
      'item.id as admin_item_id',
      'item.seagm_url as admin_item_seagm_url',
      'item.stock_note as admin_item_stock_note',
    ])
    .orderBy('redemption.created_at', 'desc')
    .orderBy('redemption.id', 'desc')
    .limit(limit + 1);
  if (query.status) builder = builder.where('redemption.status', '=', query.status);
  if (query.cursor) builder = builder.where('redemption.id', '<', query.cursor);
  const rows = await builder.execute();
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => {
      const redemption = serializeRedemption(row);
      return {
        ...redemption,
        user: {
          id: row.admin_user_id,
          email: row.admin_user_email,
          status: row.admin_user_status,
          region_id: row.admin_user_region_id,
          country_code: row.admin_user_country_code,
        },
        catalog_item: {
          id: row.admin_item_id,
          sku: redemption.reward.sku,
          title: redemption.reward.title,
          category: redemption.reward.category,
          face_value: redemption.reward.face_value,
          seagm_url: row.admin_item_seagm_url,
          stock_note: row.admin_item_stock_note,
        },
      };
    }),
    next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export function assertReviewRole(actor: AdminActor): void {
  if (!REVIEW_ROLES.includes(actor.role as (typeof REVIEW_ROLES)[number])) {
    throw new AppError('FORBIDDEN', 'Forbidden', 403);
  }
}

export function assertFulfillmentRole(actor: AdminActor): void {
  if (!FULFILLMENT_ROLES.includes(actor.role as (typeof FULFILLMENT_ROLES)[number])) {
    throw new AppError('FORBIDDEN', 'Forbidden', 403);
  }
}

export async function approveRedemption(
  redemptionId: string,
  actor: AdminActor,
  note?: string,
): Promise<RedemptionResponse> {
  assertReviewRole(actor);
  return db.transaction().execute(async (trx) => {
    const row = await transitionRedemption(trx, {
      redemptionId,
      expectedFrom: ['REQUESTED', 'FRAUD_REVIEW'],
      toStatus: 'APPROVED',
      actor: `admin:${actor.id}`,
      adminUserId: actor.id,
      note,
      patch: { reviewed_by: actor.id, reviewed_at: new Date() },
    });
    return serializeRedemption(row);
  });
}

export async function rejectRedemption(
  redemptionId: string,
  actor: AdminActor,
  reason: string,
): Promise<RedemptionResponse> {
  assertReviewRole(actor);
  return db.transaction().execute(async (trx) => {
    const row = await transitionRedemption(trx, {
      redemptionId,
      expectedFrom: ['REQUESTED', 'FRAUD_REVIEW', 'APPROVED', 'PURCHASING'],
      toStatus: 'REJECTED',
      actor: `admin:${actor.id}`,
      adminUserId: actor.id,
      note: reason,
      patch: { reviewed_by: actor.id, reviewed_at: new Date(), reject_reason: reason },
    });
    await refundRedemptionInTx(trx, row);
    return serializeRedemption(row);
  });
}

export async function fulfillRedemption(
  redemptionId: string,
  actor: AdminActor,
  note?: string,
): Promise<RedemptionResponse> {
  assertFulfillmentRole(actor);
  return db.transaction().execute(async (trx) => {
    const row = await transitionRedemption(trx, {
      redemptionId,
      expectedFrom: ['APPROVED'],
      toStatus: 'PURCHASING',
      actor: `admin:${actor.id}`,
      adminUserId: actor.id,
      note,
    });
    return serializeRedemption(row);
  });
}

export async function pasteDeliveryCode(
  redemptionId: string,
  actor: AdminActor,
  deliveryCode: string,
  note?: string,
): Promise<RedemptionResponse> {
  assertFulfillmentRole(actor);
  const encrypted = await encryptedDeliveryCode(deliveryCode);
  return db.transaction().execute(async (trx) => {
    const row = await transitionRedemption(trx, {
      redemptionId,
      expectedFrom: ['PURCHASING'],
      toStatus: 'DELIVERED',
      actor: `admin:${actor.id}`,
      adminUserId: actor.id,
      note,
      patch: { delivery_code: encrypted, delivery_note: note ?? null, delivered_at: new Date() },
    });
    await trx
      .insertInto('inbox_messages')
      .values({
        id: uuidv7(),
        user_id: row.user_id,
        type: 'redemption_delivered',
        title: 'Reward ready',
        body: 'Your redemption reward is ready to view.',
        payload: JSON.stringify({
          redemption_id: redemptionId,
          catalog_item_id: row.catalog_item_id,
        }),
      })
      .execute();
    return serializeRedemption(row);
  });
}

export async function getAdminRedemptionDetail(
  redemptionId: string,
): Promise<AdminRedemptionDetail> {
  const redemption = await db
    .selectFrom('redemptions')
    .selectAll()
    .where('id', '=', redemptionId)
    .executeTakeFirst();
  if (!redemption) {
    throw new AppError('REDEMPTION_NOT_FOUND', 'Redemption not found', 404);
  }

  const [user, catalogItem, history] = await Promise.all([
    db
      .selectFrom('users')
      .select(['id', 'email', 'status', 'trust_level', 'fraud_score', 'region_id', 'country_code'])
      .where('id', '=', redemption.user_id)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('catalog_items')
      .select([
        'id',
        'sku',
        'title',
        'category',
        'face_value',
        'image_url',
        'seagm_url',
        'usd_cost',
        'coin_price',
        'is_active',
        'stock_note',
      ])
      .where('id', '=', redemption.catalog_item_id)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('redemption_status_history')
      .selectAll()
      .where('redemption_id', '=', redemptionId)
      .orderBy('created_at', 'asc')
      .execute(),
  ]);

  return {
    redemption: serializeRedemption(redemption),
    user,
    catalog_item: catalogItem,
    history: history.map((row) => ({
      id: row.id,
      from_status: row.from_status,
      to_status: row.to_status,
      actor: row.actor,
      note: row.note,
      created_at: row.created_at.toISOString(),
    })),
  };
}
