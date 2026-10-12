import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveRegion } from '../auth/geo.js';
import { AppHeadersSchema } from '../auth/schemas.js';
import { listCatalog } from './catalog.service.js';
import { CatalogListResponseSchema } from './schemas.js';

const catalogRouteOpts = {
  schema: { headers: AppHeadersSchema, response: { 200: CatalogListResponseSchema } },
};

async function catalogHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { regionId, countryCode } = resolveRegion(request.ip);
  const result = await listCatalog(regionId, countryCode);
  await reply.code(200).send(result);
}

export function registerCatalogRoutes(app: FastifyInstance): void {
  // Primary path used by web/admin
  app.get('/catalog', catalogRouteOpts, catalogHandler);
  // Path expected by Android client (MISSING_APIS.md §6)
  app.get('/redemptions/catalog', catalogRouteOpts, catalogHandler);
}
