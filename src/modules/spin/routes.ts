import type { FastifyInstance } from 'fastify';
import type { AuthDeps } from '../auth/auth.service.js';
import { AppHeadersSchema } from '../auth/schemas.js';
import { AppError } from '../../lib/errors.js';
import { displayName } from '../../lib/display-name.js';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import { db } from '../../db/index.js';
import { getSpinState, performFreeSpin, performPaidSpin } from './spin.service.js';
import {
  RecentWinsResponseSchema,
  SpinBodySchema,
  SpinResponseSchema,
  SpinStateResponseSchema,
  type SpinBody,
} from './schemas.js';

export function registerSpinRoutes(app: FastifyInstance, deps: Pick<AuthDeps, 'accessJwt'>): void {
  const authGuard = createAuthGuard(deps.accessJwt);

  app.get(
    '/spin/state',
    {
      preHandler: authGuard,
      schema: { headers: AppHeadersSchema, response: { 200: SpinStateResponseSchema } },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const result = await getSpinState(request.authUser.sub);
      reply.code(200).send(result);
    },
  );

  app.post<{ Body: SpinBody }>(
    '/spin',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        body: SpinBodySchema,
        response: { 200: SpinResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const result = await performPaidSpin(request.authUser.sub, request.body.intent_id);
      reply.code(200).send(result);
    },
  );

  app.post<{ Body: SpinBody }>(
    '/spin/free',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        body: SpinBodySchema,
        response: { 200: SpinResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const result = await performFreeSpin(request.authUser.sub, request.body.intent_id);
      reply.code(200).send(result);
    },
  );

  // Social proof strip — public, no auth required (MISSING_APIS.md §9)
  app.get(
    '/spin/recent-wins',
    { schema: { response: { 200: RecentWinsResponseSchema } } },
    async (_request, reply) => {
      const rows = await db
        .selectFrom('spin_history')
        .select(['user_id', 'prize_type', 'prize_value', 'created_at'])
        .where('prize_type', '=', 'coin')
        .orderBy('created_at', 'desc')
        .limit(10)
        .execute();

      const wins = rows.map((row) => {
        const coinVal = Number(row.prize_value);
        return {
          username: displayName(row.user_id),
          prize_label: `${coinVal.toLocaleString()} coins`,
          prize_value: row.prize_value,
          created_at: new Date(row.created_at).toISOString(),
        };
      });

      reply.code(200).send({ wins });
    },
  );
}
