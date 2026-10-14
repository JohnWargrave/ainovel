import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createAdminGuard } from '../../plugins/admin-guard.js';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import { AppError } from '../../lib/errors.js';
import { checkSubjectRateLimit } from '../../lib/rate-limit.js';
import type { AuthDeps } from '../auth/auth.service.js';
import { listFeedback, submitFeedback } from './feedback.service.js';
import {
  AdminFeedbackListQuerySchema,
  AdminFeedbackListResponseSchema,
  FeedbackBodySchema,
  FeedbackResponseSchema,
  type AdminFeedbackListQuery,
  type FeedbackBody,
} from './schemas.js';

// Reading what readers wrote is open to everyone who handles users; nothing here changes state.
const READ_ROLES = ['analyst', 'reviewer', 'superadmin'] as const;

function userId(request: FastifyRequest): string {
  if (!request.authUser) throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
  return request.authUser.sub;
}

function appVersion(request: FastifyRequest): string | undefined {
  const header = request.headers['x-app-version'];
  return typeof header === 'string' && header !== '' ? header.slice(0, 32) : undefined;
}

export function registerFeedbackRoutes(
  app: FastifyInstance,
  deps: Pick<AuthDeps, 'accessJwt'>,
): void {
  const authGuard = createAuthGuard(deps.accessJwt);

  app.post<{ Body: FeedbackBody }>(
    '/feedback',
    {
      preHandler: authGuard,
      schema: { body: FeedbackBodySchema, response: { 200: FeedbackResponseSchema } },
    },
    async (request, reply) => {
      const sub = userId(request);
      await checkSubjectRateLimit('feedback', sub, 3600, 5);
      reply.send(await submitFeedback(sub, request.body, appVersion(request)));
    },
  );
}

export function registerFeedbackAdminRoutes(app: FastifyInstance): void {
  const readGuard = createAdminGuard(READ_ROLES);

  app.get<{ Querystring: AdminFeedbackListQuery }>(
    '/admin/feedback',
    {
      preHandler: readGuard,
      schema: {
        querystring: AdminFeedbackListQuerySchema,
        response: { 200: AdminFeedbackListResponseSchema },
      },
    },
    async (request, reply) => {
      reply.send(await listFeedback(request.query));
    },
  );
}
