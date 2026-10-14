import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createAdminGuard } from '../../plugins/admin-guard.js';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import { AppError } from '../../lib/errors.js';
import { checkSubjectRateLimit } from '../../lib/rate-limit.js';
import type { AuthDeps } from '../auth/auth.service.js';
import { listFeedback, submitFeedback } from './feedback.service.js';
import { listReports, submitReport, updateReportStatus } from './reports.service.js';
import {
  AdminFeedbackListQuerySchema,
  AdminFeedbackListResponseSchema,
  AdminReportListQuerySchema,
  AdminReportListResponseSchema,
  AdminReportParamsSchema,
  AdminReportSchema,
  AdminReportUpdateBodySchema,
  FeedbackBodySchema,
  FeedbackResponseSchema,
  ReportBodySchema,
  ReportResponseSchema,
  type AdminFeedbackListQuery,
  type AdminReportListQuery,
  type AdminReportParams,
  type AdminReportUpdateBody,
  type FeedbackBody,
  type ReportBody,
} from './schemas.js';

// Reading what readers wrote is open to everyone who handles users; nothing here changes state.
// Editors are left out: feedback carries reply-to emails and is not about content.
const READ_ROLES = ['analyst', 'reviewer', 'superadmin'] as const;
// Content reports are about novels and chapters, so editors triage them alongside reviewers.
const REPORT_READ_ROLES = ['analyst', 'reviewer', 'editor', 'superadmin'] as const;
const REPORT_WRITE_ROLES = ['reviewer', 'editor', 'superadmin'] as const;

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

  app.post<{ Body: ReportBody }>(
    '/reports',
    {
      preHandler: authGuard,
      schema: { body: ReportBodySchema, response: { 200: ReportResponseSchema } },
    },
    async (request, reply) => {
      const sub = userId(request);
      await checkSubjectRateLimit('content-report', sub, 3600, 10);
      reply.send(await submitReport(sub, request.body));
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

  app.get<{ Querystring: AdminReportListQuery }>(
    '/admin/reports',
    {
      preHandler: createAdminGuard(REPORT_READ_ROLES),
      schema: {
        querystring: AdminReportListQuerySchema,
        response: { 200: AdminReportListResponseSchema },
      },
    },
    async (request, reply) => {
      reply.send(await listReports(request.query));
    },
  );

  app.post<{ Params: AdminReportParams; Body: AdminReportUpdateBody }>(
    '/admin/reports/:id',
    {
      preHandler: createAdminGuard(REPORT_WRITE_ROLES),
      schema: {
        params: AdminReportParamsSchema,
        body: AdminReportUpdateBodySchema,
        response: { 200: AdminReportSchema },
      },
    },
    async (request, reply) => {
      if (!request.adminUser) throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
      reply.send(await updateReportStatus(request.params.id, request.adminUser.id, request.body));
    },
  );
}
