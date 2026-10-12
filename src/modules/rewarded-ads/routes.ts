import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import { AppError } from '../../lib/errors.js';
import { checkRateLimit } from '../../lib/rate-limit.js';
import type { AuthDeps } from '../auth/auth.service.js';
import { AppHeadersSchema } from '../auth/schemas.js';
import { createIntent, getRewardedAdState } from './intent.service.js';
import { processAdmobSsv, type SsvDeps } from './ssv.service.js';
import {
  IntentBodySchema,
  IntentResponseSchema,
  RewardedAdStateQuerySchema,
  RewardedAdStateResponseSchema,
  SsvQuerystringSchema,
  type IntentBody,
  type RewardedAdStateQuery,
  type SsvQuery,
} from './schemas.js';

const RATE_LIMIT_WINDOW_S = 60;
// Deliberately far above any real callback volume. Every AdMob SSV callback arrives from a small pool
// of Google server IPs, so a per-IP budget sized like the offerwall one (60/min) would start
// returning 429 at roughly one reward per second globally. Google retries a non-200 only 5 times at
// 1s intervals and then drops the reward permanently — the user watches an ad and gets nothing, with
// no recovery path. Real authentication here is the ECDSA signature plus the single-use intent; this
// counter is only a crude flood guard.
const RATE_LIMIT_MAX_REQUESTS = 6000;

export function registerRewardedAdsRoutes(
  app: FastifyInstance,
  deps: Pick<AuthDeps, 'accessJwt'> & SsvDeps,
): void {
  const authGuard = createAuthGuard(deps.accessJwt);

  app.get<{ Querystring: RewardedAdStateQuery }>(
    '/earning/rewarded-ad/state',
    {
      schema: {
        headers: AppHeadersSchema,
        querystring: RewardedAdStateQuerySchema,
        response: { 200: RewardedAdStateResponseSchema },
      },
      preHandler: authGuard,
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      reply
        .code(200)
        .send(await getRewardedAdState(request.authUser.sub, request.query.placement ?? null));
    },
  );

  // `undefined` on top of the schema's own null arm: Fastify only substitutes null when handing the
  // body to the validator, so what actually reaches the handler for a bodyless POST is undefined.
  app.post<{ Body: IntentBody | undefined }>(
    '/earning/rewarded-ad/intent',
    {
      schema: {
        headers: AppHeadersSchema,
        // Accepts a missing body so a build that predates placements still works — see IntentBodySchema.
        body: IntentBodySchema,
        response: { 200: IntentResponseSchema },
      },
      preHandler: authGuard,
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const result = await createIntent(
        request.authUser.sub,
        { ip: request.ip },
        request.body?.placement ?? null,
      );
      reply.code(200).send(result);
    },
  );

  app.route<{ Querystring: SsvQuery }>({
    method: ['GET', 'POST'],
    url: '/postback/admob_ssv',
    schema: {
      querystring: SsvQuerystringSchema,
    },
    preHandler: async (request: FastifyRequest) => {
      await checkRateLimit('admob-ssv', request.ip, RATE_LIMIT_WINDOW_S, RATE_LIMIT_MAX_REQUESTS);
    },
    handler: async (request, reply) => {
      await processAdmobSsv(
        { rawUrl: request.raw.url ?? '', query: request.query, ip: request.ip },
        {
          verifierKeyStore: deps.verifierKeyStore,
          fraudHookQueue: deps.fraudHookQueue,
          referralCreditQueue: deps.referralCreditQueue,
        },
      );
      // AdMob only checks the status code — "Your server should return an HTTP 200 OK response";
      // the body is ignored (unlike Tapjoy/AdGate's "1" convention in postback/routes.ts).
      await reply.type('text/plain').code(200).send('OK');
    },
  });
}
