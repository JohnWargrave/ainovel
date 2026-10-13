import { argon2id, hash as hashPassword, verify as verifyPassword } from 'argon2';
import { uuidv7 } from 'uuidv7';
import type { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { checkRateLimit, checkSubjectRateLimit } from '../../lib/rate-limit.js';
import {
  clearCmsSessionCookie,
  createAdminCsrfGuard,
  createAdminGuard,
  createCmsSession,
  revokeCmsSession,
  setCmsSessionCookie,
} from '../../plugins/admin-guard.js';
import {
  CmsLoginBodySchema,
  CmsSessionResponseSchema,
  type CmsLoginBody,
  type CmsSessionResponse,
} from './schemas.js';

const CMS_ROLES = ['analyst', 'editor', 'fulfillment', 'reviewer', 'superadmin'] as const;
const CMS_LOCK_THRESHOLD = 5;
const CMS_LOCK_MS = 15 * 60 * 1000;
const DUMMY_ADMIN_HASH = hashPassword('not-a-real-admin-password', {
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
});

function requireAdmin(request: { adminUser?: { id: string; role: string } }): {
  id: string;
  role: string;
} {
  if (!request.adminUser) {
    throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  }
  return request.adminUser;
}

async function loadAdminUser(adminUserId: string): Promise<CmsSessionResponse['admin_user']> {
  const adminUser = await db
    .selectFrom('admin_users')
    .select(['id', 'email', 'role'])
    .where('id', '=', adminUserId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!adminUser || !CMS_ROLES.includes(adminUser.role as (typeof CMS_ROLES)[number])) {
    throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  }
  return adminUser;
}

export function registerAdminSessionRoutes(app: FastifyInstance): void {
  const adminGuard = createAdminGuard(CMS_ROLES);
  const adminCsrfGuard = createAdminCsrfGuard();

  app.post<{ Body: CmsLoginBody }>(
    '/admin/session',
    {
      schema: {
        body: CmsLoginBodySchema,
        response: { 200: CmsSessionResponseSchema },
      },
    },
    async (request, reply) => {
      const email = request.body.email.trim().toLowerCase();
      await Promise.all([
        checkRateLimit('cms-login', request.ip, 60, 10),
        checkSubjectRateLimit('cms-login-email', email, 15 * 60, 10),
      ]);
      const row = await db
        .selectFrom('admin_users')
        .select([
          'id',
          'email',
          'role',
          'password_hash',
          'status',
          'failed_login_count',
          'locked_until',
        ])
        .where((eb) => eb.fn('lower', ['email']), '=', email)
        .executeTakeFirst();
      const digest = row?.password_hash ?? (await DUMMY_ADMIN_HASH);
      const validPassword = await verifyPassword(digest, request.body.password).catch(() => false);
      const locked = row?.locked_until ? new Date(row.locked_until) > new Date() : false;
      const accountValid =
        typeof row?.password_hash === 'string' &&
        row.status === 'active' &&
        !locked &&
        validPassword &&
        CMS_ROLES.includes(row.role as (typeof CMS_ROLES)[number]);
      if (!accountValid) {
        // While locked, failures neither count nor extend the lock — otherwise one bad attempt per
        // lock window keeps an admin out forever. Once a lock has expired the count starts over.
        if (row && !locked) {
          const lockExpired = row.locked_until !== null;
          const nextFailures = (lockExpired ? 0 : row.failed_login_count) + 1;
          await db
            .updateTable('admin_users')
            .set({
              failed_login_count: nextFailures,
              locked_until:
                nextFailures >= CMS_LOCK_THRESHOLD ? new Date(Date.now() + CMS_LOCK_MS) : null,
            })
            .where('id', '=', row.id)
            .execute();
        }
        await db
          .insertInto('audit_log')
          .values({
            id: uuidv7(),
            admin_user_id: row?.id ?? null,
            action: 'CMS_LOGIN_FAILED',
            target_type: 'admin_user',
            target_id: row?.id ?? null,
            detail: JSON.stringify({ reason: 'invalid_credentials_or_locked' }),
            ip: request.ip,
          })
          .execute();
        throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
      }

      const session = await createCmsSession(row.id, request.ip, request.headers['user-agent']);
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('admin_users')
          .set({ failed_login_count: 0, locked_until: null, last_login_at: new Date() })
          .where('id', '=', row.id)
          .execute();
        await trx
          .insertInto('audit_log')
          .values({
            id: uuidv7(),
            admin_user_id: row.id,
            action: 'CMS_LOGIN_SUCCEEDED',
            target_type: 'admin_user',
            target_id: row.id,
            detail: JSON.stringify({}),
            ip: request.ip,
          })
          .execute();
      });
      setCmsSessionCookie(reply, session.token);
      reply.code(200).send({
        admin_user: { id: row.id, email: row.email, role: row.role },
        csrf_token: session.csrfToken,
      });
    },
  );

  app.get(
    '/admin/session',
    {
      preHandler: adminGuard,
      schema: { response: { 200: CmsSessionResponseSchema } },
    },
    async (request, reply) => {
      const actor = requireAdmin(request);
      const adminUser = await loadAdminUser(actor.id);
      reply
        .code(200)
        .send({ admin_user: adminUser, csrf_token: request.adminUser?.csrfToken ?? '' });
    },
  );

  app.delete(
    '/admin/session',
    { preHandler: [adminGuard, adminCsrfGuard] },
    async (request, reply) => {
      const actor = requireAdmin(request);
      if (request.adminUser?.sessionId) await revokeCmsSession(request.adminUser.sessionId);
      await db
        .insertInto('audit_log')
        .values({
          id: uuidv7(),
          admin_user_id: actor.id,
          action: 'CMS_LOGOUT',
          target_type: 'admin_user',
          target_id: actor.id,
          detail: JSON.stringify({}),
          ip: request.ip,
        })
        .execute();
      clearCmsSessionCookie(reply);
      reply.code(204).send();
    },
  );
}
