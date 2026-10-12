import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { checkSubjectRateLimit } from '../../lib/rate-limit.js';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import type { AuthDeps } from '../auth/auth.service.js';
import { AppHeadersSchema } from '../auth/schemas.js';
import { getDirectCoinSettings, grantDirectCoin } from './direct-coin.service.js';
import {
  DirectCoinGrantBodySchema,
  DirectCoinGrantResponseSchema,
  DirectCoinStateResponseSchema,
  type DirectCoinGrantBody,
} from './direct-coin-schemas.js';

const GRANT_RATE_LIMIT_WINDOW_S = 60;
// Tighter than check-in's 10/min. Check-in is idempotent by day, so its budget only limits wasted
// round-trips; here every accepted call mints, so the budget is part of the bound on damage.
const GRANT_RATE_LIMIT_MAX = 5;

export function registerDirectCoinRoutes(
  app: FastifyInstance,
  deps: Pick<AuthDeps, 'accessJwt'>,
): void {
  const authGuard = createAuthGuard(deps.accessJwt);

  // Lets the app hide the entry point when ops switch the feature off, instead of discovering it
  // through a 404 on the grant itself.
  app.get(
    '/earning/coin/state',
    {
      preHandler: authGuard,
      schema: { headers: AppHeadersSchema, response: { 200: DirectCoinStateResponseSchema } },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const settings = await getDirectCoinSettings();
      reply.code(200).send({
        enabled: settings.enabled,
        max_amount_coin: settings.max_amount_coin,
      });
    },
  );

  app.post<{ Body: DirectCoinGrantBody }>(
    '/earning/coin',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        body: DirectCoinGrantBodySchema,
        response: { 200: DirectCoinGrantResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      await checkSubjectRateLimit(
        'direct-coin-grant',
        request.authUser.sub,
        GRANT_RATE_LIMIT_WINDOW_S,
        GRANT_RATE_LIMIT_MAX,
      );
      const result = await grantDirectCoin(
        request.authUser.sub,
        request.body.amount_coin,
        request.body.idempotency_key ?? null,
      );
      reply.code(200).send(result);
    },
  );
}
