import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { Type } from '@sinclair/typebox';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';
import { AppError } from '../../lib/errors.js';
import { db } from '../../db/index.js';
import { resolveRegion } from '../auth/geo.js';
import { AppHeadersSchema } from '../auth/schemas.js';
import { ConfigInvalidateResponseSchema, ConfigResponseSchema } from './schemas.js';
import { getConfig, invalidateConfigCache } from './config.service.js';

const SUPERADMIN_ROLES = ['superadmin'] as const;

function requireAdmin(request: { adminUser?: { id: string; role: string } }): {
  id: string;
  role: string;
} {
  if (!request.adminUser) {
    throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  }
  return request.adminUser;
}

export function registerConfigRoutes(app: FastifyInstance): void {
  const adminGuard = createAdminGuard(SUPERADMIN_ROLES);
  const adminCsrfGuard = createAdminCsrfGuard();

  app.get(
    '/config',
    {
      schema: {
        headers: AppHeadersSchema,
        response: { 200: ConfigResponseSchema, 304: Type.Null() },
      },
    },
    async (request, reply) => {
      const { regionId } = resolveRegion(request.ip);
      const result = await getConfig(regionId);
      reply.header('etag', result.etag).header('cache-control', 'private, max-age=60');
      if (request.headers['if-none-match'] === result.etag) {
        await reply.status(304).send();
        return;
      }
      reply.code(200).send(result.payload);
    },
  );

  app.post(
    '/admin/config/invalidate-cache',
    {
      preHandler: [adminGuard, adminCsrfGuard],
      schema: { response: { 200: ConfigInvalidateResponseSchema } },
    },
    async (request, reply) => {
      const actor = requireAdmin(request);
      const deleted = await invalidateConfigCache();
      await db
        .insertInto('audit_log')
        .values({
          id: uuidv7(),
          admin_user_id: actor.id,
          action: 'CONFIG_CACHE_INVALIDATED',
          target_type: 'config',
          target_id: null,
          detail: { deleted },
          ip: null,
        })
        .execute();
      reply.code(200).send({ deleted });
    },
  );
}
