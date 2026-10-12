import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';
import {
  CreateOfferwallOfferBodySchema,
  OfferwallOfferListQuerySchema,
  OfferwallOfferListResponseSchema,
  OfferwallOfferSchema,
  OfferwallProviderListResponseSchema,
  OfferwallProviderIdSchema,
  OfferwallProviderSchema,
  OfferwallRegionSettingsListResponseSchema,
  OfferwallRegionSettingsSchema,
  UpdateOfferwallOfferBodySchema,
  UpdateOfferwallProviderBodySchema,
  UpdateOfferwallRegionSettingsBodySchema,
  type CreateOfferwallOfferBody,
  type OfferwallOfferListQuery,
  type UpdateOfferwallOfferBody,
  type UpdateOfferwallProviderBody,
  type UpdateOfferwallRegionSettingsBody,
} from './offerwall-admin.schemas.js';
import {
  archiveOfferwallOffer,
  createOfferwallOffer,
  getOfferwallOfferAdmin,
  getOfferwallRegionSettings,
  listOfferwallOffersAdmin,
  listOfferwallProviders,
  listOfferwallRegionSettings,
  updateOfferwallOffer,
  updateOfferwallProvider,
  updateOfferwallRegionSettings,
  type OfferwallAdminActor,
} from './offerwall-admin.service.js';

const SUPERADMIN_ROLES = ['superadmin'] as const;
const OfferParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const ProviderParamsSchema = Type.Object({
  provider: OfferwallProviderIdSchema,
});
const RegionParamsSchema = Type.Object({ region_id: Type.String({ minLength: 1, maxLength: 16 }) });

function requireAdmin(request: { adminUser?: OfferwallAdminActor }): OfferwallAdminActor {
  if (!request.adminUser) throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  return request.adminUser;
}

export function registerOfferwallAdminRoutes(app: FastifyInstance): void {
  const adminGuard = createAdminGuard(SUPERADMIN_ROLES);
  const csrfGuard = createAdminCsrfGuard();

  app.get<{ Querystring: OfferwallOfferListQuery }>(
    '/admin/offerwall/offers',
    {
      preHandler: adminGuard,
      schema: {
        querystring: OfferwallOfferListQuerySchema,
        response: { 200: OfferwallOfferListResponseSchema },
      },
    },
    async (request, reply) => {
      requireAdmin(request);
      reply.code(200).send(await listOfferwallOffersAdmin(request.query));
    },
  );

  app.post<{ Body: CreateOfferwallOfferBody }>(
    '/admin/offerwall/offers',
    {
      preHandler: [adminGuard, csrfGuard],
      schema: { body: CreateOfferwallOfferBodySchema, response: { 200: OfferwallOfferSchema } },
    },
    async (request, reply) => {
      reply
        .code(200)
        .send(await createOfferwallOffer(requireAdmin(request), request.body, request.ip));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/admin/offerwall/offers/:id',
    {
      preHandler: adminGuard,
      schema: { params: OfferParamsSchema, response: { 200: OfferwallOfferSchema } },
    },
    async (request, reply) => {
      requireAdmin(request);
      reply.code(200).send(await getOfferwallOfferAdmin(request.params.id));
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateOfferwallOfferBody }>(
    '/admin/offerwall/offers/:id',
    {
      preHandler: [adminGuard, csrfGuard],
      schema: {
        params: OfferParamsSchema,
        body: UpdateOfferwallOfferBodySchema,
        response: { 200: OfferwallOfferSchema },
      },
    },
    async (request, reply) => {
      reply
        .code(200)
        .send(
          await updateOfferwallOffer(
            request.params.id,
            requireAdmin(request),
            request.body,
            request.ip,
          ),
        );
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/offerwall/offers/:id',
    {
      preHandler: [adminGuard, csrfGuard],
      schema: { params: OfferParamsSchema, response: { 200: OfferwallOfferSchema } },
    },
    async (request, reply) => {
      reply
        .code(200)
        .send(await archiveOfferwallOffer(request.params.id, requireAdmin(request), request.ip));
    },
  );

  app.get(
    '/admin/offerwall/providers',
    {
      preHandler: adminGuard,
      schema: { response: { 200: OfferwallProviderListResponseSchema } },
    },
    async (request, reply) => {
      requireAdmin(request);
      reply.code(200).send(await listOfferwallProviders());
    },
  );

  app.patch<{ Params: { provider: string }; Body: UpdateOfferwallProviderBody }>(
    '/admin/offerwall/providers/:provider',
    {
      preHandler: [adminGuard, csrfGuard],
      schema: {
        params: ProviderParamsSchema,
        body: UpdateOfferwallProviderBodySchema,
        response: { 200: OfferwallProviderSchema },
      },
    },
    async (request, reply) => {
      reply
        .code(200)
        .send(
          await updateOfferwallProvider(
            request.params.provider,
            requireAdmin(request),
            request.body,
            request.ip,
          ),
        );
    },
  );

  app.get(
    '/admin/offerwall/settings',
    {
      preHandler: adminGuard,
      schema: { response: { 200: OfferwallRegionSettingsListResponseSchema } },
    },
    async (request, reply) => {
      requireAdmin(request);
      reply.code(200).send(await listOfferwallRegionSettings());
    },
  );

  app.get<{ Params: { region_id: string } }>(
    '/admin/offerwall/settings/:region_id',
    {
      preHandler: adminGuard,
      schema: { params: RegionParamsSchema, response: { 200: OfferwallRegionSettingsSchema } },
    },
    async (request, reply) => {
      requireAdmin(request);
      reply.code(200).send(await getOfferwallRegionSettings(request.params.region_id));
    },
  );

  app.patch<{ Params: { region_id: string }; Body: UpdateOfferwallRegionSettingsBody }>(
    '/admin/offerwall/settings/:region_id',
    {
      preHandler: [adminGuard, csrfGuard],
      schema: {
        params: RegionParamsSchema,
        body: UpdateOfferwallRegionSettingsBodySchema,
        response: { 200: OfferwallRegionSettingsSchema },
      },
    },
    async (request, reply) => {
      reply
        .code(200)
        .send(
          await updateOfferwallRegionSettings(
            request.params.region_id,
            requireAdmin(request),
            request.body,
            request.ip,
          ),
        );
    },
  );
}
