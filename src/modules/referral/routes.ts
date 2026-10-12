import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { checkSubjectRateLimit } from '../../lib/rate-limit.js';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import type { AuthDeps } from '../auth/auth.service.js';
import { AppHeadersSchema } from '../auth/schemas.js';
import { getReferralStats, redeemReferralCode } from './referral.service.js';
import {
  ReferralRedeemBodySchema,
  ReferralRedeemResponseSchema,
  ReferralStatsResponseSchema,
  type ReferralRedeemBody,
} from './schemas.js';

const REDEEM_RATE_LIMIT_WINDOW_S = 60;
const REDEEM_RATE_LIMIT_MAX = 10;

export function registerReferralRoutes(
  app: FastifyInstance,
  deps: Pick<AuthDeps, 'accessJwt'>,
): void {
  const authGuard = createAuthGuard(deps.accessJwt);

  app.post<{ Body: ReferralRedeemBody }>(
    '/referral/redeem',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        body: ReferralRedeemBodySchema,
        response: { 200: ReferralRedeemResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      await checkSubjectRateLimit(
        'referral-redeem',
        request.authUser.sub,
        REDEEM_RATE_LIMIT_WINDOW_S,
        REDEEM_RATE_LIMIT_MAX,
      );
      await redeemReferralCode(request.authUser.sub, request.body.code, request.ip);
      reply.code(200).send({ ok: true });
    },
  );

  async function referralStatsHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.authUser) {
      throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
    }
    const result = await getReferralStats(request.authUser.sub);
    await reply.code(200).send(result);
  }

  const referralStatsOpts = {
    preHandler: authGuard,
    schema: { headers: AppHeadersSchema, response: { 200: ReferralStatsResponseSchema } },
  };

  // Original path kept for backward compat
  app.get('/referral/stats', referralStatsOpts, referralStatsHandler);
  // Short alias expected by Android client (MISSING_APIS.md §8)
  app.get('/referral', referralStatsOpts, referralStatsHandler);
}
