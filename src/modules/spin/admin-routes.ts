import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';
import { AppError } from '../../lib/errors.js';
import {
  SpinConfigAdminSchema,
  SpinConfigListResponseSchema,
  UpdateSpinConfigSchema,
  type UpdateSpinConfig,
} from './admin-schemas.js';
import { listSpinConfigs, updateSpinConfig } from './admin.service.js';

// Same bar as region_config: a spin cap is an economy lever, not a moderation action.
const SETTINGS_ROLES = ['superadmin'] as const;

const SpinConfigParamsSchema = Type.Object({
  config_id: Type.String({ minLength: 1, maxLength: 64 }),
});

function requireAdmin(request: { adminUser?: { id: string; role: string } }): {
  id: string;
  role: string;
} {
  if (!request.adminUser) throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  return request.adminUser;
}

export function registerSpinAdminRoutes(app: FastifyInstance): void {
  const settingsGuard = createAdminGuard(SETTINGS_ROLES);
  const adminCsrfGuard = createAdminCsrfGuard();

  app.get(
    '/admin/spin/configs',
    { preHandler: settingsGuard, schema: { response: { 200: SpinConfigListResponseSchema } } },
    async (request, reply) => {
      requireAdmin(request);
      reply.code(200).send(await listSpinConfigs());
    },
  );

  app.put<{ Params: { config_id: string }; Body: UpdateSpinConfig }>(
    '/admin/spin/configs/:config_id',
    {
      preHandler: [settingsGuard, adminCsrfGuard],
      schema: {
        params: SpinConfigParamsSchema,
        body: UpdateSpinConfigSchema,
        response: { 200: SpinConfigAdminSchema },
      },
    },
    async (request, reply) => {
      reply
        .code(200)
        .send(
          await updateSpinConfig(
            request.params.config_id,
            request.body,
            requireAdmin(request),
            request.ip,
          ),
        );
    },
  );
}
