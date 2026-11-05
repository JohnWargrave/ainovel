import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createAdminCsrfGuard, createAdminGuard } from '../../../plugins/admin-guard.js';
import { AppError } from '../../../lib/errors.js';
import { checkSubjectRateLimit } from '../../../lib/rate-limit.js';
import type { NovelActor } from '../admin.service.js';
import {
  CreateGenProjectSchema,
  DeletedSchema,
  GenChapterParamsSchema,
  GenIdParamsSchema,
  GenProjectListSchema,
  GenProjectSchema,
  GenerateOutlineSchema,
  RegenerateSchema,
  StartWritingSchema,
  UpdateBibleSchema,
  UpdateOutlineSchema,
  type CreateGenProjectInput,
  type GenChapterParams,
  type GenerateOutlineInput,
  type RegenerateInput,
  type StartWritingInput,
  type UpdateBibleInput,
  type UpdateOutlineInput,
} from './schemas.js';
import {
  createGenProject,
  deleteGenProject,
  generateOutline,
  getGenProject,
  listGenProjects,
  regenerateBible,
  regenerateOutlineChapter,
  startWriting,
  stopProject,
  updateBible,
  updateOutline,
} from './service.js';

const CONTENT_ROLES = ['editor', 'superadmin'] as const;

interface IdParams {
  id: string;
}

function requireAdmin(request: FastifyRequest): NovelActor {
  if (!request.adminUser) throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  return request.adminUser;
}

// Each started task is one or more paid LLM calls (a writing run is one per chapter, but one start).
async function limitSpend(actor: NovelActor): Promise<void> {
  await checkSubjectRateLimit('novel-gen', actor.id, 3600, 60);
}

// CMS "AI Studio": idea → story bible → outline → chapters, each step a background task.
export function registerNovelGenRoutes(app: FastifyInstance): void {
  const guard = createAdminGuard(CONTENT_ROLES);
  const csrf = createAdminCsrfGuard();
  const write = { preHandler: [guard, csrf] };
  const project = { 200: GenProjectSchema };

  app.get(
    '/admin/novel-gen',
    { preHandler: guard, schema: { response: { 200: GenProjectListSchema } } },
    async (_request, reply) => {
      reply.send(await listGenProjects());
    },
  );

  app.post<{ Body: CreateGenProjectInput }>(
    '/admin/novel-gen',
    { ...write, schema: { body: CreateGenProjectSchema, response: { 202: GenProjectSchema } } },
    async (request, reply) => {
      const actor = requireAdmin(request);
      await limitSpend(actor);
      reply.code(202).send(await createGenProject(request.body, actor));
    },
  );

  app.get<{ Params: IdParams }>(
    '/admin/novel-gen/:id',
    { preHandler: guard, schema: { params: GenIdParamsSchema, response: project } },
    async (request, reply) => {
      reply.send(await getGenProject(request.params.id));
    },
  );

  app.delete<{ Params: IdParams }>(
    '/admin/novel-gen/:id',
    { ...write, schema: { params: GenIdParamsSchema, response: { 200: DeletedSchema } } },
    async (request, reply) => {
      reply.send(await deleteGenProject(request.params.id));
    },
  );

  app.put<{ Params: IdParams; Body: UpdateBibleInput }>(
    '/admin/novel-gen/:id/bible',
    { ...write, schema: { params: GenIdParamsSchema, body: UpdateBibleSchema, response: project } },
    async (request, reply) => {
      reply.send(await updateBible(request.params.id, request.body.bible));
    },
  );

  app.post<{ Params: IdParams; Body: RegenerateInput }>(
    '/admin/novel-gen/:id/bible/regenerate',
    {
      ...write,
      schema: {
        params: GenIdParamsSchema,
        body: RegenerateSchema,
        response: { 202: GenProjectSchema },
      },
    },
    async (request, reply) => {
      await limitSpend(requireAdmin(request));
      reply.code(202).send(await regenerateBible(request.params.id, request.body));
    },
  );

  app.put<{ Params: IdParams; Body: UpdateOutlineInput }>(
    '/admin/novel-gen/:id/outline',
    {
      ...write,
      schema: { params: GenIdParamsSchema, body: UpdateOutlineSchema, response: project },
    },
    async (request, reply) => {
      reply.send(await updateOutline(request.params.id, request.body.outline));
    },
  );

  app.post<{ Params: IdParams; Body: GenerateOutlineInput }>(
    '/admin/novel-gen/:id/outline/generate',
    {
      ...write,
      schema: {
        params: GenIdParamsSchema,
        body: GenerateOutlineSchema,
        response: { 202: GenProjectSchema },
      },
    },
    async (request, reply) => {
      await limitSpend(requireAdmin(request));
      reply.code(202).send(await generateOutline(request.params.id, request.body));
    },
  );

  app.post<{ Params: GenChapterParams; Body: RegenerateInput }>(
    '/admin/novel-gen/:id/outline/chapters/:no/regenerate',
    {
      ...write,
      schema: {
        params: GenChapterParamsSchema,
        body: RegenerateSchema,
        response: { 202: GenProjectSchema },
      },
    },
    async (request, reply) => {
      await limitSpend(requireAdmin(request));
      reply
        .code(202)
        .send(await regenerateOutlineChapter(request.params.id, request.params.no, request.body));
    },
  );

  app.post<{ Params: IdParams; Body: StartWritingInput }>(
    '/admin/novel-gen/:id/write',
    {
      ...write,
      schema: {
        params: GenIdParamsSchema,
        body: StartWritingSchema,
        response: { 202: GenProjectSchema },
      },
    },
    async (request, reply) => {
      const actor = requireAdmin(request);
      await limitSpend(actor);
      reply
        .code(202)
        .send(await startWriting(request.params.id, request.body, actor, request.ip, request.log));
    },
  );

  app.post<{ Params: IdParams }>(
    '/admin/novel-gen/:id/stop',
    { ...write, schema: { params: GenIdParamsSchema, response: project } },
    async (request, reply) => {
      reply.send(await stopProject(request.params.id));
    },
  );
}
