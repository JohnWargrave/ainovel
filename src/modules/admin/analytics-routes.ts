import type { FastifyInstance } from 'fastify';
import { createAdminGuard } from '../../plugins/admin-guard.js';
import { getAnalyticsTimeseries, getDashboard, getEconomyAnalytics } from './analytics.service.js';
import {
  AnalyticsTimeseriesQuerySchema,
  AnalyticsTimeseriesResponseSchema,
  DashboardResponseSchema,
  EconomyAnalyticsQuerySchema,
  EconomyAnalyticsResponseSchema,
  type AnalyticsTimeseriesQuery,
  type EconomyAnalyticsQuery,
} from './schemas.js';

// Read-only aggregate — `analyst` is the role this exists for; `superadmin` inherits everything.
const ANALYTICS_ROLES = ['analyst', 'superadmin'] as const;

export function registerAdminAnalyticsRoutes(app: FastifyInstance): void {
  const adminGuard = createAdminGuard(ANALYTICS_ROLES);

  app.get<{ Querystring: EconomyAnalyticsQuery }>(
    '/admin/analytics/economy',
    {
      preHandler: adminGuard,
      schema: {
        querystring: EconomyAnalyticsQuerySchema,
        response: { 200: EconomyAnalyticsResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await getEconomyAnalytics(request.query);
      reply.code(200).send(result);
    },
  );
  app.get<{ Querystring: AnalyticsTimeseriesQuery }>(
    '/admin/analytics/timeseries',
    {
      preHandler: adminGuard,
      schema: {
        querystring: AnalyticsTimeseriesQuerySchema,
        response: { 200: AnalyticsTimeseriesResponseSchema },
      },
    },
    async (request, reply) => {
      reply.code(200).send(await getAnalyticsTimeseries(request.query));
    },
  );

  app.get(
    '/admin/dashboard',
    {
      preHandler: adminGuard,
      schema: { response: { 200: DashboardResponseSchema } },
    },
    async (_request, reply) => {
      const result = await getDashboard();
      reply.code(200).send(result);
    },
  );
}
