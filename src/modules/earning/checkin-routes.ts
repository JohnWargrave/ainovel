import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { checkSubjectRateLimit } from '../../lib/rate-limit.js';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import type { AuthDeps } from '../auth/auth.service.js';
import { AppHeadersSchema } from '../auth/schemas.js';
import { claimCheckin, claimCheckinBonus, getCheckinState } from './checkin.service.js';
import {
  CheckinClaimResponseSchema,
  CheckinDoubleBodySchema,
  CheckinDoubleResponseSchema,
  CheckinStateResponseSchema,
  type CheckinDoubleBody,
} from './checkin-schemas.js';

const CLAIM_RATE_LIMIT_WINDOW_S = 60;
const CLAIM_RATE_LIMIT_MAX = 10;

export function registerCheckinRoutes(
  app: FastifyInstance,
  deps: Pick<AuthDeps, 'accessJwt'>,
): void {
  const authGuard = createAuthGuard(deps.accessJwt);

  app.get(
    '/checkin/state',
    {
      preHandler: authGuard,
      schema: { headers: AppHeadersSchema, response: { 200: CheckinStateResponseSchema } },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const result = await getCheckinState(request.authUser.sub);
      reply.code(200).send(result);
    },
  );

  app.post(
    '/checkin/claim',
    {
      preHandler: authGuard,
      schema: { headers: AppHeadersSchema, response: { 200: CheckinClaimResponseSchema } },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      // Every other coin-minting endpoint carries its own budget; idempotency already caps what a
      // caller can earn, this caps what they can cost us in DB round-trips trying.
      await checkSubjectRateLimit(
        'checkin-claim',
        request.authUser.sub,
        CLAIM_RATE_LIMIT_WINDOW_S,
        CLAIM_RATE_LIMIT_MAX,
      );
      const result = await claimCheckin(request.authUser.sub);
      reply.code(200).send(result);
    },
  );

  app.post<{ Body: CheckinDoubleBody }>(
    '/checkin/double',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        body: CheckinDoubleBodySchema,
        response: { 200: CheckinDoubleResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      // Same budget as claim: the app retries on AD_NOT_VERIFIED while SSV catches up.
      await checkSubjectRateLimit(
        'checkin-double',
        request.authUser.sub,
        CLAIM_RATE_LIMIT_WINDOW_S,
        CLAIM_RATE_LIMIT_MAX,
      );
      const result = await claimCheckinBonus(request.authUser.sub, request.body.intent_id);
      reply.code(200).send(result);
    },
  );
}
