import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';
import { AppError } from '../../lib/errors.js';
import {
  approveCatalogStaging,
  bulkApproveCatalogStaging,
  createCatalogItem,
  ignoreCatalogStaging,
  listCatalogItemsAdmin,
  listCatalogStaging,
  updateCatalogItem,
} from './catalog.service.js';
import {
  BulkApproveBodySchema,
  BulkApproveResponseSchema,
  CatalogAdminListQuerySchema,
  CatalogAdminListResponseSchema,
  CatalogItemResponseSchema,
  CatalogStagingListQuerySchema,
  CatalogStagingListResponseSchema,
  CreateCatalogItemBodySchema,
  UpdateCatalogItemBodySchema,
  type BulkApproveBody,
  type CatalogAdminListQuery,
  type CatalogStagingListQuery,
  type CreateCatalogItemBody,
  type UpdateCatalogItemBody,
} from './schemas.js';

const ADMIN_ROLES = ['fulfillment', 'superadmin'] as const;
const CatalogItemParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
const StagingParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });

interface CatalogItemParams {
  id: string;
}

interface StagingParams {
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

export function registerCatalogAdminRoutes(app: FastifyInstance): void {
  const adminGuard = createAdminGuard(ADMIN_ROLES);
  const adminCsrfGuard = createAdminCsrfGuard();

  app.get<{ Querystring: CatalogAdminListQuery }>(
    '/admin/catalog',
    {
      preHandler: adminGuard,
      schema: {
        querystring: CatalogAdminListQuerySchema,
        response: { 200: CatalogAdminListResponseSchema },
      },
    },
    async (request, reply) => {
      requireAdmin(request);
      const result = await listCatalogItemsAdmin(request.query);
      reply.code(200).send(result);
    },
  );

  app.post<{ Body: CreateCatalogItemBody }>(
    '/admin/catalog',
    {
      preHandler: [adminGuard, adminCsrfGuard],
      schema: { body: CreateCatalogItemBodySchema, response: { 200: CatalogItemResponseSchema } },
    },
    async (request, reply) => {
      const result = await createCatalogItem(requireAdmin(request), request.body);
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: CatalogItemParams; Body: UpdateCatalogItemBody }>(
    '/admin/catalog/:id',
    {
      preHandler: [adminGuard, adminCsrfGuard],
      schema: {
        params: CatalogItemParamsSchema,
        body: UpdateCatalogItemBodySchema,
        response: { 200: CatalogItemResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await updateCatalogItem(
        request.params.id,
        requireAdmin(request),
        request.body,
      );
      reply.code(200).send(result);
    },
  );

  app.get<{ Querystring: CatalogStagingListQuery }>(
    '/admin/catalog/staging',
    {
      preHandler: adminGuard,
      schema: {
        querystring: CatalogStagingListQuerySchema,
        response: { 200: CatalogStagingListResponseSchema },
      },
    },
    async (request, reply) => {
      requireAdmin(request);
      const result = await listCatalogStaging(request.query);
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: StagingParams }>(
    '/admin/catalog/staging/:id/approve',
    { preHandler: [adminGuard, adminCsrfGuard], schema: { params: StagingParamsSchema } },
    async (request, reply) => {
      await approveCatalogStaging(request.params.id, requireAdmin(request));
      reply.code(200).send({ ok: true });
    },
  );

  app.post<{ Params: StagingParams }>(
    '/admin/catalog/staging/:id/ignore',
    { preHandler: [adminGuard, adminCsrfGuard], schema: { params: StagingParamsSchema } },
    async (request, reply) => {
      await ignoreCatalogStaging(request.params.id, requireAdmin(request));
      reply.code(200).send({ ok: true });
    },
  );

  app.post<{ Body: BulkApproveBody }>(
    '/admin/catalog/staging/bulk-approve',
    {
      preHandler: [adminGuard, adminCsrfGuard],
      schema: { body: BulkApproveBodySchema, response: { 200: BulkApproveResponseSchema } },
    },
    async (request, reply) => {
      const result = await bulkApproveCatalogStaging(requireAdmin(request), request.body);
      reply.code(200).send(result);
    },
  );
}
