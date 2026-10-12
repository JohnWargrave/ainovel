import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import type { AuthDeps } from '../auth/auth.service.js';
import { AppHeadersSchema } from '../auth/schemas.js';
import { getInboxMessage, listInbox, markInboxMessageRead } from './inbox.service.js';
import {
  InboxListQuerySchema,
  InboxListResponseSchema,
  InboxMessageParamsSchema,
  InboxMessageSchema,
  type InboxListQuery,
  type InboxMessageParams,
} from './schemas.js';

function requireUser(request: { authUser?: { sub: string } }): string {
  if (!request.authUser) {
    throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
  }
  return request.authUser.sub;
}

export function registerInboxRoutes(app: FastifyInstance, deps: Pick<AuthDeps, 'accessJwt'>): void {
  const authGuard = createAuthGuard(deps.accessJwt);

  app.get<{ Querystring: InboxListQuery }>(
    '/inbox',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        querystring: InboxListQuerySchema,
        response: { 200: InboxListResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await listInbox(requireUser(request), request.query);
      reply.code(200).send(result);
    },
  );

  app.get<{ Params: InboxMessageParams }>(
    '/inbox/:id',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        params: InboxMessageParamsSchema,
        response: { 200: InboxMessageSchema },
      },
    },
    async (request, reply) => {
      const result = await getInboxMessage(requireUser(request), request.params.id);
      reply.code(200).send(result);
    },
  );

  app.post<{ Params: InboxMessageParams }>(
    '/inbox/:id/read',
    {
      preHandler: authGuard,
      schema: {
        headers: AppHeadersSchema,
        params: InboxMessageParamsSchema,
        response: { 200: InboxMessageSchema },
      },
    },
    async (request, reply) => {
      const result = await markInboxMessageRead(requireUser(request), request.params.id);
      reply.code(200).send(result);
    },
  );
}
