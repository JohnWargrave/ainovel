import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { AuthDeps } from '../auth/auth.service.js';
import { AppHeadersSchema } from '../auth/schemas.js';
import { AppError } from '../../lib/errors.js';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import {
  CreateRedemptionBodySchema,
  DeliveryCodeResponseSchema,
  RedemptionDetailResponseSchema,
  RedemptionListQuerySchema,
  RedemptionListResponseSchema,
  RedemptionResponseSchema,
  type CreateRedemptionBody,
  type RedemptionListQuery,
} from './schemas.js';
import {
  createRedemption,
  getDeliveryCode,
  getUserRedemptionDetail,
  listUserRedemptions,
} from './redemption.service.js';

const RedemptionParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });

interface RedemptionParams {
  id: string;
}

export function registerRedemptionRoutes(
  app: FastifyInstance,
  deps: Pick<AuthDeps, 'accessJwt'>,
): void {
  const authGuard = createAuthGuard(deps.accessJwt);

  app.post<{ Body: CreateRedemptionBody }>(
    '/redemptions',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        body: CreateRedemptionBodySchema,
        response: { 200: RedemptionResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const result = await createRedemption(request.authUser.sub, request.body.catalog_item_id);
      reply.code(200).send(result);
    },
  );

  app.get<{ Querystring: RedemptionListQuery }>(
    '/redemptions',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        querystring: RedemptionListQuerySchema,
        response: { 200: RedemptionListResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const result = await listUserRedemptions(request.authUser.sub, request.query);
      reply.code(200).send(result);
    },
  );

  app.get<{ Params: RedemptionParams }>(
    '/redemptions/:id',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        params: RedemptionParamsSchema,
        response: { 200: RedemptionDetailResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const result = await getUserRedemptionDetail(request.authUser.sub, request.params.id);
      reply.code(200).send(result);
    },
  );

  app.get<{ Params: RedemptionParams }>(
    '/redemptions/:id/code',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        params: RedemptionParamsSchema,
        response: { 200: DeliveryCodeResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const result = await getDeliveryCode(request.authUser.sub, request.params.id);
      reply.code(200).send(result);
    },
  );
}
