import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { AppError } from '../lib/errors.js';

const CMS_COOKIE_NAME = 'ainovel_cms_session';
const CMS_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface AdminUserContext {
  id: string;
  role: string;
  csrfToken?: string;
  sessionId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: AdminUserContext;
  }
}

function sessionSecret(): string {
  return env.CMS_SESSION_SECRET ?? env.ADMIN_API_KEY;
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function csrfForSession(token: string): string {
  return createHmac('sha256', sessionSecret()).update(`csrf:${token}`).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) return rawValue.join('=') || null;
  }
  return null;
}

function cookieFlags(maxAgeSeconds: number): string {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
  return `Path=/; Max-Age=${String(maxAgeSeconds)}; HttpOnly; SameSite=Strict${secure}`;
}

export async function createCmsSession(
  adminUserId: string,
  ip: string,
  userAgent: string | undefined,
): Promise<{ token: string; csrfToken: string }> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = csrfForSession(token);
  await db
    .insertInto('admin_sessions')
    .values({
      id: uuidv7(),
      admin_user_id: adminUserId,
      token_hash: hashValue(token),
      csrf_hash: hashValue(csrfToken),
      expires_at: new Date(Date.now() + CMS_SESSION_TTL_MS),
      ip,
      user_agent: userAgent ?? null,
    })
    .execute();
  return { token, csrfToken };
}

export function setCmsSessionCookie(reply: FastifyReply, token: string): void {
  reply.header(
    'set-cookie',
    `${CMS_COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieFlags(CMS_SESSION_TTL_MS / 1000)}`,
  );
}

export function clearCmsSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${CMS_COOKIE_NAME}=; ${cookieFlags(0)}`);
}

export async function revokeCmsSession(sessionId: string): Promise<void> {
  await db
    .updateTable('admin_sessions')
    .set({ revoked_at: new Date() })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute();
}

export function createAdminCsrfGuard() {
  return function adminCsrfGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const csrfToken = request.headers['x-csrf-token'];
    if (
      env.ENABLE_LEGACY_ADMIN_API_KEY &&
      request.headers['x-admin-api-key'] === env.ADMIN_API_KEY &&
      csrfToken === env.ADMIN_CSRF_TOKEN
    ) {
      return Promise.resolve();
    }
    if (
      typeof csrfToken === 'string' &&
      request.adminUser?.csrfToken &&
      safeEqual(csrfToken, request.adminUser.csrfToken)
    ) {
      return Promise.resolve();
    }
    return Promise.reject(new AppError('CSRF_TOKEN_INVALID', 'Invalid CSRF token', 403));
  };
}

async function loadAdminUser(adminUserId: string): Promise<AdminUserContext | null> {
  const adminUser = await db
    .selectFrom('admin_users')
    .select(['id', 'role'])
    .where('id', '=', adminUserId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  return adminUser ?? null;
}

export function createAdminGuard(allowedRoles: readonly string[]) {
  return async function adminGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const apiKey = request.headers['x-admin-api-key'];
    const adminUserId = request.headers['x-admin-user-id'];

    if (
      env.ENABLE_LEGACY_ADMIN_API_KEY &&
      apiKey === env.ADMIN_API_KEY &&
      typeof adminUserId === 'string'
    ) {
      const adminUser = await loadAdminUser(adminUserId);
      if (!adminUser || !allowedRoles.includes(adminUser.role)) {
        throw new AppError('FORBIDDEN', 'Forbidden', 403);
      }
      request.adminUser = adminUser;
      return;
    }

    const rawCookie = parseCookie(request.headers.cookie, CMS_COOKIE_NAME);
    const token = rawCookie ? decodeURIComponent(rawCookie) : null;
    if (!token) throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);

    const session = await db
      .selectFrom('admin_sessions')
      .innerJoin('admin_users', 'admin_users.id', 'admin_sessions.admin_user_id')
      .select([
        'admin_sessions.id as session_id',
        'admin_sessions.csrf_hash',
        'admin_users.id',
        'admin_users.role',
        'admin_users.status',
      ])
      .where('admin_sessions.token_hash', '=', hashValue(token))
      .where('admin_sessions.revoked_at', 'is', null)
      .where('admin_sessions.expires_at', '>', new Date())
      .executeTakeFirst();
    const csrfToken = csrfForSession(token);
    if (session?.status !== 'active' || !safeEqual(hashValue(csrfToken), session.csrf_hash)) {
      throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
    }
    if (!allowedRoles.includes(session.role)) throw new AppError('FORBIDDEN', 'Forbidden', 403);

    request.adminUser = {
      id: session.id,
      role: session.role,
      csrfToken,
      sessionId: session.session_id,
    };
    void db
      .updateTable('admin_sessions')
      .set({ last_used_at: new Date() })
      .where('id', '=', session.session_id)
      .execute()
      .catch(() => undefined);
  };
}
