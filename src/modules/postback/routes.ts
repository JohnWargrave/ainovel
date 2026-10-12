import type { FastifyInstance, FastifyRequest } from 'fastify';
import { checkRateLimit } from '../../lib/rate-limit.js';
import { processPostback, type PostbackDeps } from './postback.service.js';
import { PostbackParamsSchema, PostbackQuerystringSchema, type PostbackParams } from './schemas.js';
import type { PostbackQuery } from './verify/types.js';

// 15§4: separate rate-limit budget for /postback/*, independent of IP allowlist/signature. Starting
// threshold, not measured from real traffic — tune once a network's actual postback volume is known.
const RATE_LIMIT_WINDOW_S = 60;
const RATE_LIMIT_MAX_REQUESTS = 60;

export function registerPostbackRoutes(app: FastifyInstance, deps: PostbackDeps): void {
  app.route<{ Params: PostbackParams; Querystring: PostbackQuery }>({
    method: ['GET', 'POST'],
    url: '/postback/:network',
    schema: {
      params: PostbackParamsSchema,
      querystring: PostbackQuerystringSchema,
    },
    preHandler: async (request: FastifyRequest<{ Params: PostbackParams }>) => {
      await checkRateLimit('postback', request.ip, RATE_LIMIT_WINDOW_S, RATE_LIMIT_MAX_REQUESTS);
    },
    handler: async (request, reply) => {
      await processPostback(request.params.network, { ip: request.ip, query: request.query }, deps);
      // Tapjoy's self-managed currency docs specify no required response *body* — only the status
      // code carries meaning (200 = credited, 403 = terminal failure, anything else = retry every 5
      // minutes for up to four days). "1" stays as the common offerwall convention; the charset is
      // declared explicitly because the same docs state a non-UTF-8 response triggers a retry even
      // on a 200, and a four-day retry loop over a header we never set is not worth the risk.
      await reply.type('text/plain; charset=utf-8').code(200).send('1');
    },
  });
}
