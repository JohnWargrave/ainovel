import type { FastifyInstance } from 'fastify';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';
import { AppError } from '../../lib/errors.js';
import {
  confirmFraudFlag,
  dismissFraudFlag,
  listFraudFlags,
  type AdminActor,
} from './fraud-admin.service.js';
import {
  FraudFlagListQuerySchema,
  FraudFlagListResponseSchema,
  FraudFlagParamsSchema,
  FraudFlagReviewBodySchema,
  FraudFlagReviewResponseSchema,
  type FraudFlagListQuery,
  type FraudFlagParams,
  type FraudFlagReviewBody,
} from './schemas.js';

// 12-ADMIN-SECURITY.md §RBAC: fraud review belongs to reviewers; fulfillment must not touch it.
const ADMIN_ROLES = ['reviewer', 'superadmin'] as const;

function requireAdmin(request: { adminUser?: AdminActor }): AdminActor {
  if (!request.adminUser) {
    throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  }
  return request.adminUser;
}

export function registerFraudAdminRoutes(app: FastifyInstance): void {
  const adminGuard = createAdminGuard(ADMIN_ROLES);
  const adminCsrfGuard = createAdminCsrfGuard();

  app.get<{ Querystring: FraudFlagListQuery }>(
    '/admin/fraud/flags',
    {
      preHandler: adminGuard,
      schema: {
        querystring: FraudFlagListQuerySchema,
        response: { 200: FraudFlagListResponseSchema },
      },
    },
    async (request, reply) => {
      requireAdmin(request);
      const result = await listFraudFlags(request.query);
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: FraudFlagParams; Body: FraudFlagReviewBody }>(
    '/admin/fraud/flags/:id/dismiss',
    {
      preHandler: [adminGuard, adminCsrfGuard],
      schema: {
        params: FraudFlagParamsSchema,
        body: FraudFlagReviewBodySchema,
        response: { 200: FraudFlagReviewResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await dismissFraudFlag(
        request.params.id,
        requireAdmin(request),
        request.body.note,
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: FraudFlagParams; Body: FraudFlagReviewBody }>(
    '/admin/fraud/flags/:id/confirm',
    {
      preHandler: [adminGuard, adminCsrfGuard],
      schema: {
        params: FraudFlagParamsSchema,
        body: FraudFlagReviewBodySchema,
        response: { 200: FraudFlagReviewResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await confirmFraudFlag(
        request.params.id,
        requireAdmin(request),
        request.body.note,
      );
      reply.code(200).send(result);
    },
  );
}
