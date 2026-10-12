import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';
import { AppError } from '../../lib/errors.js';
import {
  DramaRegionSettingsSchema,
  DramaSettingsListResponseSchema,
  UpdateDramaRegionSettingsSchema,
  type UpdateDramaRegionSettings,
} from './admin-schemas.js';
import { listDramaSettings, updateDramaSettings } from './admin.service.js';

// 12-ADMIN-SECURITY.md §RBAC: region_config is superadmin-only, and drama lives inside it.
const SETTINGS_ROLES = ['superadmin'] as const;

const RegionParamsSchema = Type.Object({ region_id: Type.String({ minLength: 1, maxLength: 16 }) });

function requireAdmin(request: { adminUser?: { id: string; role: string } }): {
  id: string;
  role: string;
} {
  if (!request.adminUser) throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  return request.adminUser;
}

export function registerDramaAdminRoutes(app: FastifyInstance): void {
  const settingsGuard = createAdminGuard(SETTINGS_ROLES);
  const adminCsrfGuard = createAdminCsrfGuard();

  app.get(
    '/admin/drama/settings',
    { preHandler: settingsGuard, schema: { response: { 200: DramaSettingsListResponseSchema } } },
    async (request, reply) => {
      requireAdmin(request);
      reply.code(200).send(await listDramaSettings());
    },
  );

  app.put<{ Params: { region_id: string }; Body: UpdateDramaRegionSettings }>(
    '/admin/drama/settings/:region_id',
    {
      preHandler: [settingsGuard, adminCsrfGuard],
      schema: {
        params: RegionParamsSchema,
        body: UpdateDramaRegionSettingsSchema,
        response: { 200: DramaRegionSettingsSchema },
      },
    },
    async (request, reply) => {
      reply
        .code(200)
        .send(
          await updateDramaSettings(
            request.params.region_id,
            request.body,
            requireAdmin(request),
            request.ip,
          ),
        );
    },
  );
}
