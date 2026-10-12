import type { FastifyInstance } from 'fastify';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';
import { AppError } from '../../lib/errors.js';
import {
  banUser,
  adjustUserCoin,
  disableUserCredential,
  getAdminUserDetail,
  listAdminUsers,
  reinstateUser,
  setTrustLevel,
  grantTestCredit,
  revokeAdminUserSession,
  revokeAdminUserSessions,
  suspendUser,
  type AdminActor,
} from './users-admin.service.js';
import {
  AdminTrustLevelBodySchema,
  AdminCoinAdjustmentBodySchema,
  AdminCredentialParamsSchema,
  AdminSessionParamsSchema,
  AdminTestCreditBodySchema,
  AdminTestCreditResponseSchema,
  AdminUserListQuerySchema,
  AdminUserListResponseSchema,
  AdminUserActionBodySchema,
  AdminUserDetailSchema,
  AdminUserParamsSchema,
  type AdminTrustLevelBody,
  type AdminCoinAdjustmentBody,
  type AdminCredentialParams,
  type AdminSessionParams,
  type AdminTestCreditBody,
  type AdminUserListQuery,
  type AdminUserActionBody,
  type AdminUserParams,
} from './schemas.js';

// 12-ADMIN-SECURITY.md §RBAC: only superadmin locks or unlocks an account. Reviewers can read the
// record because the fraud queue is theirs, but the action itself is not.
const WRITE_ROLES = ['superadmin'] as const;
const READ_ROLES = ['reviewer', 'superadmin'] as const;

function requireAdmin(request: { adminUser?: AdminActor }): AdminActor {
  if (!request.adminUser) {
    throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  }
  return request.adminUser;
}

export function registerAdminUsersRoutes(app: FastifyInstance): void {
  const readGuard = createAdminGuard(READ_ROLES);
  const writeGuard = createAdminGuard(WRITE_ROLES);
  const adminCsrfGuard = createAdminCsrfGuard();

  app.get<{ Querystring: AdminUserListQuery }>(
    '/admin/users',
    {
      preHandler: readGuard,
      schema: {
        querystring: AdminUserListQuerySchema,
        response: { 200: AdminUserListResponseSchema },
      },
    },
    async (request, reply) => {
      requireAdmin(request);
      const result = await listAdminUsers(request.query);
      reply.code(200).send(result);
    },
  );

  app.get<{ Params: AdminUserParams }>(
    '/admin/users/:id',
    {
      preHandler: readGuard,
      schema: { params: AdminUserParamsSchema, response: { 200: AdminUserDetailSchema } },
    },
    async (request, reply) => {
      requireAdmin(request);
      const result = await getAdminUserDetail(request.params.id);
      reply.code(200).send(result);
    },
  );

  const actionOpts = {
    preHandler: [writeGuard, adminCsrfGuard],
    schema: {
      params: AdminUserParamsSchema,
      body: AdminUserActionBodySchema,
      response: { 200: AdminUserDetailSchema },
    },
  };

  app.post<{ Params: AdminUserParams; Body: AdminUserActionBody }>(
    '/admin/users/:id/suspend',
    actionOpts,
    async (request, reply) => {
      const result = await suspendUser(
        request.params.id,
        requireAdmin(request),
        request.body.reason,
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: AdminUserParams; Body: AdminUserActionBody }>(
    '/admin/users/:id/ban',
    actionOpts,
    async (request, reply) => {
      const result = await banUser(request.params.id, requireAdmin(request), request.body.reason);
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: AdminUserParams; Body: AdminUserActionBody }>(
    '/admin/users/:id/reinstate',
    actionOpts,
    async (request, reply) => {
      const result = await reinstateUser(
        request.params.id,
        requireAdmin(request),
        request.body.reason,
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: AdminUserParams; Body: AdminTrustLevelBody }>(
    '/admin/users/:id/trust-level',
    {
      preHandler: [writeGuard, adminCsrfGuard],
      schema: {
        params: AdminUserParamsSchema,
        body: AdminTrustLevelBodySchema,
        response: { 200: AdminUserDetailSchema },
      },
    },
    async (request, reply) => {
      const result = await setTrustLevel(
        request.params.id,
        requireAdmin(request),
        request.body.trust_level,
        request.body.reason,
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: AdminUserParams; Body: AdminTestCreditBody }>(
    '/admin/users/:id/test-credit',
    {
      preHandler: [writeGuard, adminCsrfGuard],
      schema: {
        params: AdminUserParamsSchema,
        body: AdminTestCreditBodySchema,
        response: { 200: AdminTestCreditResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await grantTestCredit(
        request.params.id,
        requireAdmin(request),
        request.body.amount_coin,
        request.body.reason,
        request.body.idempotency_key,
        request.ip,
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: AdminUserParams; Body: AdminCoinAdjustmentBody }>(
    '/admin/users/:id/coin-adjustment',
    {
      preHandler: [writeGuard, adminCsrfGuard],
      schema: {
        params: AdminUserParamsSchema,
        body: AdminCoinAdjustmentBodySchema,
        response: { 200: AdminTestCreditResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await adjustUserCoin(
        request.params.id,
        requireAdmin(request),
        request.body,
        request.ip,
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: AdminUserParams; Body: AdminUserActionBody }>(
    '/admin/users/:id/sessions/revoke-all',
    actionOpts,
    async (request, reply) => {
      const result = await revokeAdminUserSessions(
        request.params.id,
        requireAdmin(request),
        request.body.reason,
      );
      reply.code(200).send(result);
    },
  );

  app.delete<{ Params: AdminSessionParams; Body: AdminUserActionBody }>(
    '/admin/users/:id/sessions/:sessionId',
    {
      preHandler: [writeGuard, adminCsrfGuard],
      schema: {
        params: AdminSessionParamsSchema,
        body: AdminUserActionBodySchema,
        response: { 200: AdminUserDetailSchema },
      },
    },
    async (request, reply) => {
      const result = await revokeAdminUserSession(
        request.params.id,
        request.params.sessionId,
        requireAdmin(request),
        request.body.reason,
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: AdminCredentialParams; Body: AdminUserActionBody }>(
    '/admin/users/:id/credentials/:provider/disable',
    {
      preHandler: [writeGuard, adminCsrfGuard],
      schema: {
        params: AdminCredentialParamsSchema,
        body: AdminUserActionBodySchema,
        response: { 200: AdminUserDetailSchema },
      },
    },
    async (request, reply) => {
      const result = await disableUserCredential(
        request.params.id,
        request.params.provider,
        requireAdmin(request),
        request.body.reason,
      );
      reply.code(200).send(result);
    },
  );
}
