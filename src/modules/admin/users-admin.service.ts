import { uuidv7 } from 'uuidv7';
import { sql, type Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { creditInTransaction, debitInTransaction } from '../wallet-ledger/ledger.service.js';
import { recordMint } from '../wallet-ledger/economy-counters.js';
import { listActiveSessions } from '../auth/jwt.js';
import type {
  AdminCoinAdjustmentBody,
  AdminTestCreditResponse,
  AdminUserDetail,
  AdminUserListQuery,
  AdminUserListResponse,
  AdminUserSummary,
} from './schemas.js';

export interface AdminActor {
  id: string;
  role: string;
}

type AccountStatus = 'active' | 'suspended' | 'banned';

const STATUS_ACTIONS: Record<AccountStatus, string> = {
  active: 'ADMIN_USER_REINSTATED',
  suspended: 'ADMIN_USER_SUSPENDED',
  banned: 'ADMIN_USER_BANNED',
};

async function writeAudit(
  trx: Transaction<DB>,
  actor: AdminActor,
  action: string,
  userId: string,
  detail: unknown,
): Promise<void> {
  await trx
    .insertInto('audit_log')
    .values({
      id: uuidv7(),
      admin_user_id: actor.id,
      action,
      target_type: 'user',
      target_id: userId,
      detail: JSON.stringify(detail),
      ip: null,
    })
    .execute();
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function getAdminUserDetail(userId: string): Promise<AdminUserDetail> {
  const user = await db
    .selectFrom('users')
    .select([
      'id',
      'auth_provider',
      'email',
      'country_code',
      'region_id',
      'status',
      'trust_level',
      'fraud_score',
      'referral_code',
      'created_at',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) {
    throw new AppError('NOT_FOUND', 'User not found', 404);
  }

  const [
    wallet,
    flags,
    passwordCredential,
    identities,
    welcomeCredit,
    activeSessions,
    authEvents,
    ledger,
    adminAudit,
  ] = await Promise.all([
    db
      .selectFrom('wallets')
      .select(['available_coin', 'pending_coin', 'lifetime_earned', 'lifetime_redeemed'])
      .where('user_id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('fraud_flags')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('user_id', '=', userId)
      .where('status', '=', 'open')
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('password_credentials')
      .select([
        'username',
        'email',
        'email_verified_at',
        'password_changed_at',
        'disabled_at',
        'created_at',
      ])
      .where('user_id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('user_identities')
      .select([
        'provider',
        'email',
        'email_verified_at',
        'last_used_at',
        'disabled_at',
        'created_at',
      ])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'asc')
      .execute(),
    db
      .selectFrom('coin_ledger')
      .select(['amount', 'created_at'])
      .where('user_id', '=', userId)
      .where('entry_type', '=', 'WELCOME_CREDIT')
      .executeTakeFirst(),
    listActiveSessions(userId),
    db
      .selectFrom('auth_events')
      .select([
        'id',
        'provider',
        'event_type',
        'outcome',
        'failure_code',
        'ip',
        'device_id',
        'metadata',
        'created_at',
      ])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(30)
      .execute(),
    db
      .selectFrom('coin_ledger')
      .select(['id', 'entry_type', 'amount', 'bucket', 'balance_after', 'note', 'created_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute(),
    db
      .selectFrom('audit_log')
      .select(['id', 'admin_user_id', 'action', 'detail', 'created_at'])
      .where('target_type', '=', 'user')
      .where('target_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(30)
      .execute(),
  ]);

  return {
    id: user.id,
    auth_provider: user.auth_provider,
    email: user.email,
    country_code: user.country_code,
    region_id: user.region_id,
    status: user.status,
    trust_level: user.trust_level,
    fraud_score: user.fraud_score,
    referral_code: user.referral_code,
    created_at: new Date(user.created_at).toISOString(),
    // A user row without a wallet row should be impossible, but the admin console is the wrong place
    // to 500 over it — zeros make the anomaly visible instead of hiding the whole record.
    wallet: {
      available_coin: wallet?.available_coin ?? '0',
      pending_coin: wallet?.pending_coin ?? '0',
      lifetime_earned: wallet?.lifetime_earned ?? '0',
      lifetime_redeemed: wallet?.lifetime_redeemed ?? '0',
    },
    open_flag_count: Number(flags.count),
    password_credential: passwordCredential
      ? {
          username: passwordCredential.username,
          email: passwordCredential.email,
          email_verified_at: passwordCredential.email_verified_at?.toISOString() ?? null,
          password_changed_at: passwordCredential.password_changed_at.toISOString(),
          disabled_at: passwordCredential.disabled_at?.toISOString() ?? null,
          created_at: passwordCredential.created_at.toISOString(),
        }
      : null,
    identities: identities.map((identity) => ({
      provider: identity.provider,
      email: identity.email,
      email_verified_at: identity.email_verified_at?.toISOString() ?? null,
      last_used_at: identity.last_used_at.toISOString(),
      disabled_at: identity.disabled_at?.toISOString() ?? null,
      created_at: identity.created_at.toISOString(),
    })),
    welcome_credit: {
      granted: welcomeCredit !== undefined,
      amount: welcomeCredit?.amount ?? null,
      granted_at: welcomeCredit?.created_at.toISOString() ?? null,
    },
    active_sessions: activeSessions,
    auth_events: authEvents.map((event) => ({
      ...event,
      metadata: jsonValue(event.metadata),
      created_at: event.created_at.toISOString(),
    })),
    ledger: ledger.map((entry) => ({ ...entry, created_at: entry.created_at.toISOString() })),
    admin_audit: adminAudit.map((entry) => ({
      ...entry,
      detail: jsonValue(entry.detail),
      created_at: entry.created_at.toISOString(),
    })),
  };
}

// Idempotent by design (same reasoning as applyScore in fraud/score.service.ts): re-issuing a
// suspend on an already-suspended account is a no-op and writes no second audit row, so a
// double-clicked console button does not pollute the trail.
async function setAccountStatus(
  userId: string,
  actor: AdminActor,
  nextStatus: AccountStatus,
  reason: string,
): Promise<AdminUserDetail> {
  await db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select(['id', 'status'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!user) {
      throw new AppError('NOT_FOUND', 'User not found', 404);
    }
    if (user.status === nextStatus) return;

    await trx
      .updateTable('users')
      .set({ status: nextStatus, updated_at: new Date() })
      .where('id', '=', userId)
      .execute();

    if (nextStatus !== 'active') {
      await trx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date(), revocation_reason: `account_${nextStatus}` })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .execute();
    }

    await writeAudit(trx, actor, STATUS_ACTIONS[nextStatus], userId, {
      from: user.status,
      to: nextStatus,
      reason,
    });
  });

  return getAdminUserDetail(userId);
}

export async function suspendUser(
  userId: string,
  actor: AdminActor,
  reason: string,
): Promise<AdminUserDetail> {
  return setAccountStatus(userId, actor, 'suspended', reason);
}

export async function banUser(
  userId: string,
  actor: AdminActor,
  reason: string,
): Promise<AdminUserDetail> {
  return setAccountStatus(userId, actor, 'banned', reason);
}

// Not in 03-API-CONTRACT.md §7, but the fraud engine soft-bans automatically (AUTO_FRAUD_SUSPEND);
// without a way back every false positive would be permanent. Deliberately does NOT clear
// fraud_score or the flags behind it — undoing those is the reviewer's separate decision on each
// flag (POST /admin/fraud/flags/:id/dismiss), and clearing them here would erase the evidence.
export async function reinstateUser(
  userId: string,
  actor: AdminActor,
  reason: string,
): Promise<AdminUserDetail> {
  return setAccountStatus(userId, actor, 'active', reason);
}

export async function setTrustLevel(
  userId: string,
  actor: AdminActor,
  trustLevel: number,
  reason: string,
): Promise<AdminUserDetail> {
  await db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select(['id', 'trust_level'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!user) {
      throw new AppError('NOT_FOUND', 'User not found', 404);
    }
    if (user.trust_level === trustLevel) return;

    await trx
      .updateTable('users')
      .set({ trust_level: trustLevel, updated_at: new Date() })
      .where('id', '=', userId)
      .execute();

    await writeAudit(trx, actor, 'ADMIN_USER_TRUST_LEVEL_CHANGED', userId, {
      from: user.trust_level,
      to: trustLevel,
      reason,
    });
  });

  return getAdminUserDetail(userId);
}

export async function grantTestCredit(
  userId: string,
  actor: AdminActor,
  amountCoin: number,
  reason: string,
  idempotencyKey: string,
  ip: string,
): Promise<AdminTestCreditResponse> {
  if (env.NODE_ENV === 'production' || !env.ENABLE_TEST_COIN_API) {
    throw new AppError('TEST_COIN_DISABLED', 'Test coin credits are not available', 404);
  }

  return db.transaction().execute(async (trx) => {
    const wallet = await trx
      .selectFrom('wallets')
      .select('available_coin')
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!wallet) {
      throw new AppError('NOT_FOUND', 'User or wallet not found', 404);
    }

    const ledgerKey = `admin-test-credit:${userId}:${idempotencyKey}`;
    const existing = await trx
      .selectFrom('coin_ledger')
      .select(['id', 'amount', 'balance_after', 'note'])
      .where('idempotency_key', '=', ledgerKey)
      .executeTakeFirst();
    const note = `Test credit: ${reason}`;
    if (existing) {
      if (existing.amount !== String(amountCoin) || existing.note !== note) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key was already used with different credit details',
          409,
        );
      }
      return {
        ledger_id: existing.id,
        amount_coin: amountCoin,
        previous_balance: (BigInt(existing.balance_after) - BigInt(existing.amount)).toString(),
        new_balance: existing.balance_after,
        deduped: true,
      };
    }

    const ledger = await creditInTransaction(trx, {
      userId,
      entryType: 'ADMIN_ADJUSTMENT',
      amount: amountCoin,
      bucket: 'available',
      idempotencyKey: ledgerKey,
      note,
    });

    await trx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: actor.id,
        action: 'ADMIN_TEST_CREDIT_GRANTED',
        target_type: 'user',
        target_id: userId,
        detail: JSON.stringify({
          amount_coin: amountCoin,
          previous_balance: wallet.available_coin,
          new_balance: ledger.balanceAfter,
          ledger_id: ledger.ledgerId,
          reason,
          idempotency_key: idempotencyKey,
        }),
        ip,
      })
      .execute();

    return {
      ledger_id: ledger.ledgerId,
      amount_coin: amountCoin,
      previous_balance: (BigInt(ledger.balanceAfter) - BigInt(amountCoin)).toString(),
      new_balance: ledger.balanceAfter,
      deduped: false,
    };
  });
}

export async function adjustUserCoin(
  userId: string,
  actor: AdminActor,
  input: AdminCoinAdjustmentBody,
  ip: string,
): Promise<AdminTestCreditResponse> {
  const result = await db.transaction().execute(async (trx) => {
    const wallet = await trx
      .selectFrom('wallets')
      .select('available_coin')
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!wallet) throw new AppError('NOT_FOUND', 'User or wallet not found', 404);

    const ledgerKey = `admin-adjustment:${userId}:${input.idempotency_key}`;
    const note = `Admin adjustment: ${input.reason}`;
    const existing = await trx
      .selectFrom('coin_ledger')
      .select(['id', 'amount', 'balance_after', 'note'])
      .where('idempotency_key', '=', ledgerKey)
      .executeTakeFirst();
    if (existing) {
      if (existing.amount !== String(input.amount_coin) || existing.note !== note) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key was already used with different adjustment details',
          409,
        );
      }
      return {
        response: {
          ledger_id: existing.id,
          amount_coin: input.amount_coin,
          previous_balance: (BigInt(existing.balance_after) - BigInt(existing.amount)).toString(),
          new_balance: existing.balance_after,
          deduped: true,
        },
        regionId: null,
        mintedAmount: 0,
      };
    }

    const ledgerResult =
      input.amount_coin > 0
        ? await creditInTransaction(trx, {
            userId,
            entryType: 'ADMIN_ADJUSTMENT',
            amount: input.amount_coin,
            idempotencyKey: ledgerKey,
            note,
          })
        : await debitInTransaction(trx, {
            userId,
            entryType: 'ADMIN_ADJUSTMENT',
            amount: Math.abs(input.amount_coin),
            idempotencyKey: ledgerKey,
            note,
          });

    await trx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: actor.id,
        action: 'ADMIN_USER_COIN_ADJUSTED',
        target_type: 'user',
        target_id: userId,
        detail: JSON.stringify({
          amount_coin: input.amount_coin,
          previous_balance: wallet.available_coin,
          new_balance: ledgerResult.balanceAfter,
          ledger_id: ledgerResult.ledgerId,
          reason: input.reason,
          idempotency_key: input.idempotency_key,
        }),
        ip,
      })
      .execute();

    return {
      response: {
        ledger_id: ledgerResult.ledgerId,
        amount_coin: input.amount_coin,
        previous_balance: wallet.available_coin,
        new_balance: ledgerResult.balanceAfter,
        deduped: false,
      },
      regionId: 'regionId' in ledgerResult ? (ledgerResult.regionId as string | null) : null,
      mintedAmount: input.amount_coin > 0 ? input.amount_coin : 0,
    };
  });
  if (result.regionId && result.mintedAmount > 0) {
    void recordMint(result.regionId, result.mintedAmount).catch(() => undefined);
  }
  return result.response;
}

export async function revokeAdminUserSession(
  userId: string,
  sessionId: string,
  actor: AdminActor,
  reason: string,
): Promise<AdminUserDetail> {
  await db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date(), revocation_reason: 'admin_revoked' })
      .where('user_id', '=', userId)
      .where('session_id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      throw new AppError('NOT_FOUND', 'Active session not found', 404);
    }
    await writeAudit(trx, actor, 'ADMIN_USER_SESSION_REVOKED', userId, {
      session_id: sessionId,
      reason,
    });
  });
  return getAdminUserDetail(userId);
}

export async function revokeAdminUserSessions(
  userId: string,
  actor: AdminActor,
  reason: string,
): Promise<AdminUserDetail> {
  await db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);
    const result = await trx
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date(), revocation_reason: 'admin_revoked_all' })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    await writeAudit(trx, actor, 'ADMIN_USER_SESSIONS_REVOKED', userId, {
      revoked_count: Number(result.numUpdatedRows),
      reason,
    });
  });
  return getAdminUserDetail(userId);
}

export async function disableUserCredential(
  userId: string,
  provider: 'guest' | 'google' | 'facebook' | 'password',
  actor: AdminActor,
  reason: string,
): Promise<AdminUserDetail> {
  await db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select(['id', 'auth_provider'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!user) throw new AppError('NOT_FOUND', 'User not found', 404);

    const identities = await trx
      .selectFrom('user_identities')
      .select(['provider', 'provider_subject', 'disabled_at'])
      .where('user_id', '=', userId)
      .execute();
    const password = await trx
      .selectFrom('password_credentials')
      .select(['username', 'email', 'disabled_at'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const targetActive =
      provider === 'password'
        ? password?.disabled_at === null
        : identities.some((item) => item.provider === provider && item.disabled_at === null);
    if (!targetActive) throw new AppError('NOT_FOUND', 'Active login method not found', 404);

    const otherIdentities = identities.filter(
      (item) => item.provider !== provider && item.disabled_at === null,
    );
    const hasOtherPassword = provider !== 'password' && password?.disabled_at === null;
    if (otherIdentities.length === 0 && !hasOtherPassword) {
      throw new AppError('LAST_LOGIN_METHOD', 'Cannot disable the last usable login method', 409);
    }

    if (provider === 'password') {
      await trx
        .updateTable('password_credentials')
        .set({ disabled_at: new Date() })
        .where('user_id', '=', userId)
        .execute();
    } else {
      await trx
        .updateTable('user_identities')
        .set({ disabled_at: new Date() })
        .where('user_id', '=', userId)
        .where('provider', '=', provider)
        .execute();
    }

    if (user.auth_provider === provider) {
      const replacement = otherIdentities[0];
      await trx
        .updateTable('users')
        .set(
          replacement
            ? {
                auth_provider: replacement.provider,
                auth_subject: replacement.provider_subject,
                updated_at: new Date(),
              }
            : {
                auth_provider: 'password',
                auth_subject: password?.username ?? userId,
                email: password?.email ?? null,
                updated_at: new Date(),
              },
        )
        .where('id', '=', userId)
        .execute();
    }

    await trx
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date(), revocation_reason: 'credential_disabled' })
      .where('user_id', '=', userId)
      .where('auth_provider', '=', provider)
      .where('revoked_at', 'is', null)
      .execute();
    await writeAudit(trx, actor, 'ADMIN_USER_CREDENTIAL_DISABLED', userId, {
      provider,
      reason,
    });
  });
  return getAdminUserDetail(userId);
}

const DEFAULT_USER_LIST_LIMIT = 50;

interface AdminUserSummaryRow {
  id: string;
  auth_provider: string;
  email: string | null;
  country_code: string;
  region_id: string;
  status: string;
  trust_level: number;
  fraud_score: number;
  created_at: Date;
  available_coin: string | null;
  pending_coin: string | null;
  lifetime_earned: string | null;
  lifetime_redeemed: string | null;
  open_flag_count: string;
}

function serializeAdminUserSummary(row: AdminUserSummaryRow): AdminUserSummary {
  return {
    id: row.id,
    auth_provider: row.auth_provider,
    email: row.email,
    country_code: row.country_code,
    region_id: row.region_id,
    status: row.status,
    trust_level: row.trust_level,
    fraud_score: row.fraud_score,
    created_at: row.created_at.toISOString(),
    wallet: {
      available_coin: row.available_coin ?? '0',
      pending_coin: row.pending_coin ?? '0',
      lifetime_earned: row.lifetime_earned ?? '0',
      lifetime_redeemed: row.lifetime_redeemed ?? '0',
    },
    open_flag_count: Number(row.open_flag_count),
  };
}

export async function listAdminUsers(query: AdminUserListQuery): Promise<AdminUserListResponse> {
  const limit = query.limit ?? DEFAULT_USER_LIST_LIMIT;
  let builder = db
    .selectFrom('users')
    .leftJoin('wallets', 'wallets.user_id', 'users.id')
    .select([
      'users.id as id',
      'users.auth_provider as auth_provider',
      'users.email as email',
      'users.country_code as country_code',
      'users.region_id as region_id',
      'users.status as status',
      'users.trust_level as trust_level',
      'users.fraud_score as fraud_score',
      'users.created_at as created_at',
      'wallets.available_coin as available_coin',
      'wallets.pending_coin as pending_coin',
      'wallets.lifetime_earned as lifetime_earned',
      'wallets.lifetime_redeemed as lifetime_redeemed',
      sql<string>`(
        select count(*) from fraud_flags
        where fraud_flags.user_id = users.id and fraud_flags.status = 'open'
      )`.as('open_flag_count'),
    ])
    .orderBy('users.id', 'desc')
    .limit(limit + 1);

  if (query.q) {
    const pattern = `%${query.q}%`;
    builder = builder.where((eb) =>
      eb.or([
        eb('users.id', '=', query.q ?? ''),
        eb('users.email', 'ilike', pattern),
        eb('users.referral_code', 'ilike', pattern),
        sql<boolean>`exists (
          select 1 from password_credentials credential
          where credential.user_id = users.id and credential.username ilike ${pattern}
        )`,
      ]),
    );
  }
  if (query.status) builder = builder.where('users.status', '=', query.status);
  if (query.region_id) builder = builder.where('users.region_id', '=', query.region_id);
  if (query.cursor) builder = builder.where('users.id', '<', query.cursor);

  const rows = (await builder.execute()) as AdminUserSummaryRow[];
  const page = rows.slice(0, limit);
  return {
    items: page.map(serializeAdminUserSummary),
    next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}
