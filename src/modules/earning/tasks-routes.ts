import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { checkSubjectRateLimit } from '../../lib/rate-limit.js';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import type { AuthDeps } from '../auth/auth.service.js';
import { AppHeadersSchema } from '../auth/schemas.js';
import { listTasks, claimTask } from './tasks.service.js';
import {
  TaskClaimBodySchema,
  TaskClaimResponseSchema,
  TaskListResponseSchema,
  type TaskClaimBody,
} from './tasks-schemas.js';

const CLAIM_RATE_LIMIT_WINDOW_S = 60;
const CLAIM_RATE_LIMIT_MAX = 20;

export function registerTasksRoutes(app: FastifyInstance, deps: Pick<AuthDeps, 'accessJwt'>): void {
  const authGuard = createAuthGuard(deps.accessJwt);

  app.get(
    '/earning/tasks',
    {
      preHandler: authGuard,
      schema: { headers: AppHeadersSchema, response: { 200: TaskListResponseSchema } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      const result = await listTasks(request.authUser.sub);
      await reply.code(200).send(result);
    },
  );

  app.post<{ Body: TaskClaimBody }>(
    '/earning/tasks/claim',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        body: TaskClaimBodySchema,
        response: { 200: TaskClaimResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      }
      await checkSubjectRateLimit(
        'task-claim',
        request.authUser.sub,
        CLAIM_RATE_LIMIT_WINDOW_S,
        CLAIM_RATE_LIMIT_MAX,
      );
      const result = await claimTask(request.authUser.sub, request.body.task_id);
      await reply.code(200).send(result);
    },
  );
}
