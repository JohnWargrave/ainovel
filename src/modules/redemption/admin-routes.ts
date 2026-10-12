import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';
import { AppError } from '../../lib/errors.js';
import {
  AdminNoteBodySchema,
  AdminRedemptionDetailSchema,
  AdminRedemptionListResponseSchema,
  AdminRedemptionListQuerySchema,
  AdminRejectBodySchema,
  PasteCodeBodySchema,
  RedemptionResponseSchema,
  type AdminNoteBody,
  type AdminRedemptionListQuery,
  type AdminRejectBody,
  type PasteCodeBody,
} from './schemas.js';
import {
  approveRedemption,
  getAdminRedemptionDetail,
  fulfillRedemption,
  listAdminRedemptions,
  pasteDeliveryCode,
  rejectRedemption,
} from './redemption.service.js';
import {
  RedemptionRegionSettingsSchema,
  RedemptionSettingsListResponseSchema,
  UpdateRedemptionRegionSettingsSchema,
  type UpdateRedemptionRegionSettings,
} from './settings-schemas.js';
import { listRedemptionSettings, updateRedemptionSettings } from './settings.service.js';

const ADMIN_ROLES = ['reviewer', 'fulfillment', 'superadmin'] as const;
const SETTINGS_ROLES = ['superadmin'] as const;
const RedemptionParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const RegionParamsSchema = Type.Object({ region_id: Type.String({ minLength: 1, maxLength: 16 }) });

interface RedemptionParams {
  id: string;
}

function requireAdmin(request: { adminUser?: { id: string; role: string } }): {
  id: string;
  role: string;
} {
  if (!request.adminUser) {
    throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  }
  return request.adminUser;
}

export function registerRedemptionAdminRoutes(app: FastifyInstance): void {
  const adminGuard = createAdminGuard(ADMIN_ROLES);
  const settingsGuard = createAdminGuard(SETTINGS_ROLES);
  const adminCsrfGuard = createAdminCsrfGuard();

  app.get(
    '/admin/redemption/settings',
    {
      preHandler: settingsGuard,
      schema: { response: { 200: RedemptionSettingsListResponseSchema } },
    },
    async (request, reply) => {
      requireAdmin(request);
      reply.code(200).send(await listRedemptionSettings());
    },
  );

  app.put<{ Params: { region_id: string }; Body: UpdateRedemptionRegionSettings }>(
    '/admin/redemption/settings/:region_id',
    {
      preHandler: [settingsGuard, adminCsrfGuard],
      schema: {
        params: RegionParamsSchema,
        body: UpdateRedemptionRegionSettingsSchema,
        response: { 200: RedemptionRegionSettingsSchema },
      },
    },
    async (request, reply) => {
      reply
        .code(200)
        .send(
          await updateRedemptionSettings(
            request.params.region_id,
            request.body,
            requireAdmin(request),
            request.ip,
          ),
        );
    },
  );

  app.get<{ Querystring: AdminRedemptionListQuery }>(
    '/admin/redemptions',
    {
      preHandler: adminGuard,
      schema: {
        querystring: AdminRedemptionListQuerySchema,
        response: { 200: AdminRedemptionListResponseSchema },
      },
    },
    async (request, reply) => {
      requireAdmin(request);
      const result = await listAdminRedemptions(request.query);
      reply.code(200).send(result);
    },
  );

  app.get<{ Params: RedemptionParams }>(
    '/admin/redemptions/:id',
    {
      preHandler: adminGuard,
      schema: {
        params: RedemptionParamsSchema,
        response: { 200: AdminRedemptionDetailSchema },
      },
    },
    async (request, reply) => {
      requireAdmin(request);
      const result = await getAdminRedemptionDetail(request.params.id);
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: RedemptionParams; Body: AdminNoteBody }>(
    '/admin/redemptions/:id/approve',
    {
      preHandler: [adminGuard, adminCsrfGuard],
      schema: {
        params: RedemptionParamsSchema,
        body: AdminNoteBodySchema,
        response: { 200: RedemptionResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await approveRedemption(
        request.params.id,
        requireAdmin(request),
        request.body.note,
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: RedemptionParams; Body: AdminRejectBody }>(
    '/admin/redemptions/:id/reject',
    {
      preHandler: [adminGuard, adminCsrfGuard],
      schema: {
        params: RedemptionParamsSchema,
        body: AdminRejectBodySchema,
        response: { 200: RedemptionResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await rejectRedemption(
        request.params.id,
        requireAdmin(request),
        request.body.reason,
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: RedemptionParams; Body: AdminNoteBody }>(
    '/admin/redemptions/:id/fulfill',
    {
      preHandler: [adminGuard, adminCsrfGuard],
      schema: {
        params: RedemptionParamsSchema,
        body: AdminNoteBodySchema,
        response: { 200: RedemptionResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await fulfillRedemption(
        request.params.id,
        requireAdmin(request),
        request.body.note,
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: RedemptionParams; Body: PasteCodeBody }>(
    '/admin/redemptions/:id/paste-code',
    {
      preHandler: [adminGuard, adminCsrfGuard],
      schema: {
        params: RedemptionParamsSchema,
        body: PasteCodeBodySchema,
        response: { 200: RedemptionResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await pasteDeliveryCode(
        request.params.id,
        requireAdmin(request),
        request.body.delivery_code,
        request.body.note,
      );
      reply.code(200).send(result);
    },
  );
}
