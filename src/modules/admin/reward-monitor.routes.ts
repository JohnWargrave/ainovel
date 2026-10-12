import type { FastifyInstance } from 'fastify';
import { createAdminGuard } from '../../plugins/admin-guard.js';
import {
  RewardMonitorParamsSchema,
  RewardMonitorQuerySchema,
  RewardMonitorResponseSchema,
  type RewardMonitorParams,
  type RewardMonitorQuery,
} from './reward-monitor.schemas.js';
import { getRewardMonitor } from './reward-monitor.service.js';

const MONITOR_ROLES = ['analyst', 'fulfillment', 'reviewer', 'superadmin'] as const;

export function registerAdminRewardMonitorRoutes(app: FastifyInstance): void {
  const adminGuard = createAdminGuard(MONITOR_ROLES);

  app.get<{ Params: RewardMonitorParams; Querystring: RewardMonitorQuery }>(
    '/admin/reward-monitors/:network',
    {
      preHandler: adminGuard,
      schema: {
        params: RewardMonitorParamsSchema,
        querystring: RewardMonitorQuerySchema,
        response: { 200: RewardMonitorResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await getRewardMonitor(request.params.network, request.query);
      reply.code(200).send(result);
    },
  );
}
