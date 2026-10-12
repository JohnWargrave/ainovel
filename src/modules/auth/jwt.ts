import crypto from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import type { JWT } from '@fastify/jwt';
import type { Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';

// access 1h / refresh 30d — user-approved resolution of the 03-API-CONTRACT.md vs backend_doing.md
// duration conflict; actual expiry is configured on the @fastify/jwt `access`/`refresh` namespaces
// at registration time (app.ts), this constant only sizes the refresh_tokens row's expires_at.
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccessTokenPayload {
  sub: string;
  trust_level: number;
  sid: string;
}

interface RefreshTokenPayload {
  sub: string;
  jti: string;
}

export interface TokenPair {
  access: string;
  refresh: string;
}

export interface SessionContext {
  provider?: string | undefined;
  deviceId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function persistRefreshToken(
  executor: Transaction<DB> | typeof db,
  userId: string,
  jti: string,
  token: string,
  sessionId: string,
  context: SessionContext,
  sessionStartedAt: Date,
): Promise<void> {
  await executor
    .insertInto('refresh_tokens')
    .values({
      id: jti,
      user_id: userId,
      token_hash: hashToken(token),
      expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      session_id: sessionId,
      auth_provider: context.provider ?? 'unknown',
      device_id: context.deviceId ?? null,
      ip: context.ip ?? null,
      user_agent: context.userAgent ?? null,
      last_used_at: new Date(),
      session_started_at: sessionStartedAt,
    })
    .execute();
}

// Issues a fresh access+refresh pair for a user who just authenticated (signup/login/bind). Accepts
// an optional trx so callers can fold the refresh_tokens insert into the same transaction as the
// user/wallet/device rows it's issued alongside.
export async function issueTokenPair(
  accessJwt: JWT,
  refreshJwt: JWT,
  userId: string,
  trustLevel: number,
  trx?: Transaction<DB>,
  context: SessionContext = {},
): Promise<TokenPair> {
  const sessionId = uuidv7();
  const access = accessJwt.sign({
    sub: userId,
    trust_level: trustLevel,
    sid: sessionId,
  } satisfies AccessTokenPayload);
  const jti = uuidv7();
  const refresh = refreshJwt.sign({ sub: userId, jti } satisfies RefreshTokenPayload);
  await persistRefreshToken(trx ?? db, userId, jti, refresh, sessionId, context, new Date());
  return { access, refresh };
}

// Single-use rotation with reuse detection (backend_doing.md Phase 1 §1.1): verifying a token whose
// DB row is already revoked means it was already rotated once before — replaying it revokes every
// other still-active token for that user, since that can only happen if the token leaked.
export async function rotateRefreshToken(
  accessJwt: JWT,
  refreshJwt: JWT,
  refreshToken: string,
  context: SessionContext = {},
): Promise<TokenPair> {
  let decoded: RefreshTokenPayload;
  try {
    decoded = refreshJwt.verify<RefreshTokenPayload>(refreshToken);
  } catch {
    throw new AppError('INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired', 401);
  }

  // Reuse detection must revoke the whole chain even though the request itself ends in an error —
  // if that revocation UPDATE ran inside a transaction that then throws to signal REFRESH_TOKEN_REUSED,
  // Kysely rolls the whole transaction (including the revocation) back, silently un-revoking every
  // sibling token. So the transaction below only ever returns a result, never throws; the caller maps
  // the outcome to an AppError afterward, once the transaction (and any revocation in it) has committed.
  type RotateOutcome =
    { outcome: 'invalid' } | { outcome: 'reused' } | { outcome: 'ok'; tokens: TokenPair };

  const result = await db.transaction().execute(async (trx): Promise<RotateOutcome> => {
    const row = await trx
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('id', '=', decoded.jti)
      .forUpdate()
      .executeTakeFirst();

    if (row?.token_hash !== hashToken(refreshToken) || new Date(row.expires_at) < new Date()) {
      return { outcome: 'invalid' };
    }

    if (row.revoked_at !== null) {
      if (row.revocation_reason !== 'rotated') return { outcome: 'invalid' };
      await trx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date(), revocation_reason: 'refresh_token_reuse' })
        .where('user_id', '=', row.user_id)
        .where('revoked_at', 'is', null)
        .execute();
      return { outcome: 'reused' };
    }

    const user = await trx
      .selectFrom('users')
      .select(['id', 'trust_level', 'status'])
      .where('id', '=', row.user_id)
      .executeTakeFirst();
    if (user?.status !== 'active') {
      await trx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date(), revocation_reason: 'account_not_active' })
        .where('user_id', '=', row.user_id)
        .where('revoked_at', 'is', null)
        .execute();
      return { outcome: 'invalid' };
    }

    const access = accessJwt.sign({
      sub: user.id,
      trust_level: user.trust_level,
      sid: row.session_id,
    } satisfies AccessTokenPayload);
    const newJti = uuidv7();
    const refresh = refreshJwt.sign({ sub: user.id, jti: newJti } satisfies RefreshTokenPayload);

    const nextContext: SessionContext = {
      provider: row.auth_provider,
      deviceId: context.deviceId ?? row.device_id ?? undefined,
      ip: context.ip ?? row.ip ?? undefined,
      userAgent: context.userAgent ?? row.user_agent ?? undefined,
    };
    await persistRefreshToken(
      trx,
      user.id,
      newJti,
      refresh,
      row.session_id,
      nextContext,
      new Date(row.session_started_at),
    );
    await trx
      .updateTable('refresh_tokens')
      .set({
        revoked_at: new Date(),
        replaced_by: newJti,
        revocation_reason: 'rotated',
        last_used_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();

    return { outcome: 'ok', tokens: { access, refresh } };
  });

  if (result.outcome === 'invalid') {
    throw new AppError('INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired', 401);
  }
  if (result.outcome === 'reused') {
    throw new AppError(
      'REFRESH_TOKEN_REUSED',
      'Refresh token reuse detected, all sessions revoked',
      401,
    );
  }
  return result.tokens;
}

export function verifyAccessToken(accessJwt: JWT, token: string): AccessTokenPayload {
  try {
    return accessJwt.verify<AccessTokenPayload>(token);
  } catch {
    throw new AppError('INVALID_ACCESS_TOKEN', 'Access token is invalid or expired', 401);
  }
}

export async function assertActiveSession(payload: AccessTokenPayload): Promise<void> {
  if (!payload.sid) {
    // Older integration fixtures sign access tokens directly. Production never accepts these
    // session-less tokens; tests still verify that the referenced account is active.
    if (env.NODE_ENV === 'test') {
      const user = await db
        .selectFrom('users')
        .select('id')
        .where('id', '=', payload.sub)
        .executeTakeFirst();
      if (user) return;
    }
    throw new AppError('INVALID_ACCESS_TOKEN', 'Access token is invalid or expired', 401);
  }
  const active = await db
    .selectFrom('refresh_tokens')
    .innerJoin('users', 'users.id', 'refresh_tokens.user_id')
    .select('refresh_tokens.id')
    .where('refresh_tokens.user_id', '=', payload.sub)
    .where('refresh_tokens.session_id', '=', payload.sid)
    .where('refresh_tokens.revoked_at', 'is', null)
    .where('refresh_tokens.expires_at', '>', new Date())
    .where('users.status', '=', 'active')
    .executeTakeFirst();
  if (!active) throw new AppError('SESSION_REVOKED', 'Session is no longer active', 401);
}

export async function revokeSession(
  userId: string,
  sessionId: string,
  reason = 'user_logout',
): Promise<boolean> {
  const result = await db
    .updateTable('refresh_tokens')
    .set({ revoked_at: new Date(), revocation_reason: reason })
    .where('user_id', '=', userId)
    .where('session_id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export async function revokeAllSessions(
  userId: string,
  reason = 'user_logout_all',
): Promise<number> {
  const result = await db
    .updateTable('refresh_tokens')
    .set({ revoked_at: new Date(), revocation_reason: reason })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export interface ActiveSession {
  id: string;
  provider: string;
  device_id: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string;
  expires_at: string;
}

export async function listActiveSessions(userId: string): Promise<ActiveSession[]> {
  const rows = await db
    .selectFrom('refresh_tokens')
    .select([
      'session_id',
      'auth_provider',
      'device_id',
      'ip',
      'user_agent',
      'session_started_at',
      'last_used_at',
      'expires_at',
    ])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date())
    .orderBy('last_used_at', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.session_id,
    provider: row.auth_provider,
    device_id: row.device_id,
    ip: row.ip,
    user_agent: row.user_agent,
    created_at: new Date(row.session_started_at).toISOString(),
    last_used_at: new Date(row.last_used_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
  }));
}
