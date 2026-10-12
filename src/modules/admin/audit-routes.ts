import type { FastifyInstance } from 'fastify';
import { createAdminGuard } from '../../plugins/admin-guard.js';
import { AppError } from '../../lib/errors.js';
import { listAuditLog } from './audit.service.js';
import {
  AuditLogListQuerySchema,
  AuditLogListResponseSchema,
  type AuditLogListQuery,
} from './schemas.js';

const AUDIT_ROLES = ['analyst', 'superadmin'] as const;

function requireAdmin(request: { adminUser?: { id: string; role: string } }): void {
  if (!request.adminUser) {
    throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  }
}

export function registerAdminAuditRoutes(app: FastifyInstance): void {
  const adminGuard = createAdminGuard(AUDIT_ROLES);

  app.get<{ Querystring: AuditLogListQuery }>(
    '/admin/audit-log',
    {
      preHandler: adminGuard,
      schema: {
        querystring: AuditLogListQuerySchema,
        response: { 200: AuditLogListResponseSchema },
      },
    },
    async (request, reply) => {
      requireAdmin(request);
      const result = await listAuditLog(request.query);
      reply.code(200).send(result);
    },
  );
}
