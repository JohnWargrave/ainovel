import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveRegion } from '../auth/geo.js';
import { AppHeadersSchema } from '../auth/schemas.js';
import { getOfferwallOffers } from './offerwall.service.js';
import { OfferwallOffersResponseSchema } from './offerwall-schemas.js';

export function registerOfferwallRoutes(app: FastifyInstance): void {
  // Public and geo-resolved, like GET /config: this returns which networks a region shows, not
  // anything about the caller. The SDK handshake that actually attributes a conversion is
  // authenticated separately (postback/:network).
  app.get(
    '/offerwall/offers',
    {
      schema: { headers: AppHeadersSchema, response: { 200: OfferwallOffersResponseSchema } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { regionId } = resolveRegion(request.ip);
      const result = await getOfferwallOffers(regionId);
      await reply.code(200).send(result);
    },
  );
}
