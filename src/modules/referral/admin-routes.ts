import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';
import {
  AdminReferralCodeRegenerateSchema,
  AdminReferralCodeUpdateSchema,
  AdminReferralDetailSchema,
  AdminReferralFreezeClearSchema,
  AdminReferralListQuerySchema,
  AdminReferralListResponseSchema,
  AdminReferralSettingsListSchema,
  AdminReferralSettingsParamsSchema,
  AdminReferralSettingsSchema,
  AdminReferralSettingsUpdateSchema,
  AdminReferralUserParamsSchema,
  type AdminReferralCodeRegenerate,
  type AdminReferralCodeUpdate,
  type AdminReferralFreezeClear,
  type AdminReferralListQuery,
  type AdminReferralSettingsParams,
  type AdminReferralSettingsUpdate,
  type AdminReferralUserParams,
} from './admin-schemas.js';
import {
  getAdminReferralDetail,
  clearReferralFreeze,
  listAdminReferrals,
  listReferralSettings,
  regenerateReferralCode,
  updateReferralCode,
  updateReferralSettings,
  type ReferralAdminActor,
} from './admin.service.js';

const READ_ROLES = ['reviewer', 'analyst', 'superadmin'] as const;
const WRITE_ROLES = ['superadmin'] as const;
const REVIEW_ROLES = ['reviewer', 'superadmin'] as const;

function requireAdmin(request: { adminUser?: ReferralAdminActor }): ReferralAdminActor {
  if (!request.adminUser) throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  return request.adminUser;
}

export function registerReferralAdminRoutes(app: FastifyInstance): void {
  const readGuard = createAdminGuard(READ_ROLES);
  const writeGuard = createAdminGuard(WRITE_ROLES);
  const reviewGuard = createAdminGuard(REVIEW_ROLES);
  const csrfGuard = createAdminCsrfGuard();

  app.get(
    '/admin/referrals/settings',
    {
      preHandler: readGuard,
      schema: { response: { 200: AdminReferralSettingsListSchema } },
    },
    async (request, reply) => {
      requireAdmin(request);
      reply.code(200).send(await listReferralSettings());
    },
  );

  app.put<{ Params: AdminReferralSettingsParams; Body: AdminReferralSettingsUpdate }>(
    '/admin/referrals/settings/:region_id',
    {
      preHandler: [writeGuard, csrfGuard],
      schema: {
        params: AdminReferralSettingsParamsSchema,
        body: AdminReferralSettingsUpdateSchema,
        response: { 200: AdminReferralSettingsSchema },
      },
    },
    async (request, reply) => {
      const result = await updateReferralSettings(
        request.params.region_id,
        request.body,
        requireAdmin(request),
      );
      reply.code(200).send(result);
    },
  );

  app.get<{ Querystring: AdminReferralListQuery }>(
    '/admin/referrals',
    {
      preHandler: readGuard,
      schema: {
        querystring: AdminReferralListQuerySchema,
        response: { 200: AdminReferralListResponseSchema },
      },
    },
    async (request, reply) => {
      requireAdmin(request);
      reply.code(200).send(await listAdminReferrals(request.query));
    },
  );

  app.get<{ Params: AdminReferralUserParams }>(
    '/admin/referrals/:id',
    {
      preHandler: readGuard,
      schema: {
        params: AdminReferralUserParamsSchema,
        response: { 200: AdminReferralDetailSchema },
      },
    },
    async (request, reply) => {
      requireAdmin(request);
      reply.code(200).send(await getAdminReferralDetail(request.params.id));
    },
  );

  app.put<{ Params: AdminReferralUserParams; Body: AdminReferralCodeUpdate }>(
    '/admin/referrals/:id/code',
    {
      preHandler: [writeGuard, csrfGuard],
      schema: {
        params: AdminReferralUserParamsSchema,
        body: AdminReferralCodeUpdateSchema,
        response: { 200: AdminReferralDetailSchema },
      },
    },
    async (request, reply) => {
      const result = await updateReferralCode(
        request.params.id,
        request.body,
        requireAdmin(request),
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: AdminReferralUserParams; Body: AdminReferralCodeRegenerate }>(
    '/admin/referrals/:id/code/regenerate',
    {
      preHandler: [writeGuard, csrfGuard],
      schema: {
        params: AdminReferralUserParamsSchema,
        body: AdminReferralCodeRegenerateSchema,
        response: { 200: AdminReferralDetailSchema },
      },
    },
    async (request, reply) => {
      const result = await regenerateReferralCode(
        request.params.id,
        request.body.reason,
        requireAdmin(request),
      );
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: AdminReferralUserParams; Body: AdminReferralFreezeClear }>(
    '/admin/referrals/:id/clear-freeze',
    {
      preHandler: [reviewGuard, csrfGuard],
      schema: {
        params: AdminReferralUserParamsSchema,
        body: AdminReferralFreezeClearSchema,
        response: { 200: AdminReferralDetailSchema },
      },
    },
    async (request, reply) => {
      const result = await clearReferralFreeze(
        request.params.id,
        request.body.reason,
        requireAdmin(request),
      );
      reply.code(200).send(result);
    },
  );
}
