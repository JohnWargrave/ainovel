import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';
import { AppError } from '../../lib/errors.js';
import {
  RewardedAdsRegionSettingsSchema,
  RewardedAdsSettingsListResponseSchema,
  UpdateRewardedAdsRegionSettingsSchema,
  type UpdateRewardedAdsRegionSettings,
} from './admin-schemas.js';
import { listRewardedAdsSettings, updateRewardedAdsSettings } from './admin.service.js';

// 12-ADMIN-SECURITY.md §RBAC: region_config is superadmin-only, and rewarded_ads lives inside it.
const SETTINGS_ROLES = ['superadmin'] as const;

const RegionParamsSchema = Type.Object({ region_id: Type.String({ minLength: 1, maxLength: 16 }) });

function requireAdmin(request: { adminUser?: { id: string; role: string } }): {
  id: string;
  role: string;
} {
  if (!request.adminUser) throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  return request.adminUser;
}

export function registerRewardedAdsAdminRoutes(app: FastifyInstance): void {
  const settingsGuard = createAdminGuard(SETTINGS_ROLES);
  const adminCsrfGuard = createAdminCsrfGuard();

  app.get(
    '/admin/rewarded-ads/settings',
    {
      preHandler: settingsGuard,
      schema: { response: { 200: RewardedAdsSettingsListResponseSchema } },
    },
    async (request, reply) => {
      requireAdmin(request);
      reply.code(200).send(await listRewardedAdsSettings());
    },
  );

  app.put<{ Params: { region_id: string }; Body: UpdateRewardedAdsRegionSettings }>(
    '/admin/rewarded-ads/settings/:region_id',
    {
      preHandler: [settingsGuard, adminCsrfGuard],
      schema: {
        params: RegionParamsSchema,
        body: UpdateRewardedAdsRegionSettingsSchema,
        response: { 200: RewardedAdsRegionSettingsSchema },
      },
    },
    async (request, reply) => {
      reply
        .code(200)
        .send(
          await updateRewardedAdsSettings(
            request.params.region_id,
            request.body,
            requireAdmin(request),
            request.ip,
          ),
        );
    },
  );
}
