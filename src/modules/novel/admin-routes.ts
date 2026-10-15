import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { Type } from '@sinclair/typebox';
import { uuidv7 } from 'uuidv7';
import { createAdminCsrfGuard, createAdminGuard } from '../../plugins/admin-guard.js';
import { AppError } from '../../lib/errors.js';
import { checkSubjectRateLimit } from '../../lib/rate-limit.js';
import type { NovelImportFormat, NovelImportMode } from '../../db/types.js';
import {
  AdminCategoryListSchema,
  AdminCategorySchema,
  AdminChapterListQuerySchema,
  AdminChapterListSchema,
  AdminChapterSchema,
  AdminNovelListQuerySchema,
  AdminNovelListSchema,
  AdminNovelSchema,
  BulkChapterActionSchema,
  BulkNovelActionSchema,
  BulkResultSchema,
  CategoryInputSchema,
  ChapterIdParamsSchema,
  ChapterRevisionListSchema,
  CreateChapterSchema,
  CreateNovelSchema,
  IdParamsSchema,
  NovelRegionSettingsSchema,
  NovelSettingsListSchema,
  NovelStatsQuerySchema,
  NovelStatsSchema,
  RegionParamsSchema,
  RenumberResultSchema,
  RevisionParamsSchema,
  TopNovelsSchema,
  UpdateChapterSchema,
  UpdateNovelRegionSettingsSchema,
  UpdateNovelSchema,
  type AdminChapterListQuery,
  type AdminNovelListQuery,
  type BulkChapterAction,
  type BulkNovelAction,
  type CategoryInput,
  type ChapterIdParams,
  type CreateChapterInput,
  type CreateNovelInput,
  type IdParams,
  type NovelStatsQuery,
  type RevisionParams,
  type UpdateChapterInput,
  type UpdateNovelInput,
  type UpdateNovelRegionSettings,
} from './admin-schemas.js';
import {
  bulkChapters,
  bulkNovels,
  createCategory,
  createChapter,
  createNovel,
  deleteCategory,
  deleteChapter,
  deleteNovel,
  getAdminChapter,
  getAdminNovel,
  listAdminCategories,
  listAdminChapters,
  listAdminNovels,
  listRevisions,
  renumberChapters,
  restoreRevision,
  setNovelCover,
  updateCategory,
  updateChapter,
  updateNovel,
  type NovelActor,
} from './admin.service.js';
import {
  CoverJobSchema,
  CreateCoverJobSchema,
  LatestCoverJobSchema,
  type CreateCoverJobInput,
} from './cover-ai/schemas.js';
import { applyCoverCandidate, createCoverJob, getLatestCoverJob } from './cover-ai/service.js';
import { listNovelSettings, updateNovelSettings } from './settings.service.js';
import { getNovelStats, getTopNovels } from './stats.service.js';
import { detectImageType, getObjectStorage } from './storage.js';
import {
  CommitImportSchema,
  ImportChapterPageSchema,
  ImportChaptersQuerySchema,
  ImportJobListQuerySchema,
  ImportJobListSchema,
  ImportJobSchema,
  type CommitImportInput,
  type ImportChaptersQuery,
  type ImportJobListQuery,
} from './import/import-schemas.js';
import {
  cancelImportJob,
  commitImportJob,
  createImportJob,
  getImportJob,
  listImportChapters,
  listImportJobs,
} from './import/import.service.js';
import { exportCatalogCsv, exportNovel, type ExportFile } from './export/export.service.js';

// 12-ADMIN-SECURITY.md §RBAC: content is managed by editors; reward economics (region_config) stay
// superadmin-only like every other region setting; analysts get read-only stats.
const CONTENT_ROLES = ['editor', 'superadmin'] as const;
const STATS_ROLES = ['analyst', 'editor', 'superadmin'] as const;
const SETTINGS_ROLES = ['superadmin'] as const;

const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const IMPORT_FORMATS = ['epub', 'txt', 'md', 'docx', 'json', 'zip'] as const;
const IMPORT_MODES = ['new', 'append', 'replace'] as const;

const ExportQuerySchema = Type.Object({
  format: Type.Optional(
    Type.Union([
      Type.Literal('json'),
      Type.Literal('zip'),
      Type.Literal('epub'),
      Type.Literal('txt'),
    ]),
  ),
});

function requireAdmin(request: FastifyRequest): NovelActor {
  if (!request.adminUser) throw new AppError('UNAUTHORIZED', 'Unauthorized', 401);
  return request.adminUser;
}

function sendFile(reply: FastifyReply, file: ExportFile): void {
  const asciiName = file.filename.replace(/[^\w.-]+/gu, '_');
  reply
    .code(200)
    .header('content-type', file.contentType)
    .header(
      'content-disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    )
    .header('cache-control', 'no-store')
    .send(file.body);
}

function fieldValue(fields: Record<string, unknown>, name: string): string | undefined {
  const field = fields[name] as { type?: string; value?: unknown } | undefined;
  return field?.type === 'field' && typeof field.value === 'string' && field.value !== ''
    ? field.value
    : undefined;
}

export function registerNovelAdminRoutes(app: FastifyInstance): void {
  const contentGuard = createAdminGuard(CONTENT_ROLES);
  const statsGuard = createAdminGuard(STATS_ROLES);
  const settingsGuard = createAdminGuard(SETTINGS_ROLES);
  const csrf = createAdminCsrfGuard();

  // ---- Categories ----
  app.get(
    '/admin/novel-categories',
    { preHandler: statsGuard, schema: { response: { 200: AdminCategoryListSchema } } },
    async (_request, reply) => {
      reply.send(await listAdminCategories());
    },
  );
  app.post<{ Body: CategoryInput }>(
    '/admin/novel-categories',
    {
      preHandler: [contentGuard, csrf],
      schema: { body: CategoryInputSchema, response: { 200: AdminCategorySchema } },
    },
    async (request, reply) => {
      reply.send(await createCategory(request.body, requireAdmin(request), request.ip));
    },
  );
  app.post<{ Params: IdParams; Body: CategoryInput }>(
    '/admin/novel-categories/:id',
    {
      preHandler: [contentGuard, csrf],
      schema: {
        params: IdParamsSchema,
        body: CategoryInputSchema,
        response: { 200: AdminCategorySchema },
      },
    },
    async (request, reply) => {
      reply.send(
        await updateCategory(request.params.id, request.body, requireAdmin(request), request.ip),
      );
    },
  );
  app.delete<{ Params: IdParams }>(
    '/admin/novel-categories/:id',
    { preHandler: [contentGuard, csrf], schema: { params: IdParamsSchema } },
    async (request, reply) => {
      reply.send(await deleteCategory(request.params.id, requireAdmin(request), request.ip));
    },
  );

  // ---- Novels ----
  app.get<{ Querystring: AdminNovelListQuery }>(
    '/admin/novels',
    {
      preHandler: statsGuard,
      schema: { querystring: AdminNovelListQuerySchema, response: { 200: AdminNovelListSchema } },
    },
    async (request, reply) => {
      reply.send(await listAdminNovels(request.query));
    },
  );
  app.post<{ Body: CreateNovelInput }>(
    '/admin/novels',
    {
      preHandler: [contentGuard, csrf],
      schema: { body: CreateNovelSchema, response: { 200: AdminNovelSchema } },
    },
    async (request, reply) => {
      reply.send(await createNovel(request.body, requireAdmin(request), request.ip));
    },
  );
  app.post<{ Body: BulkNovelAction }>(
    '/admin/novels/bulk',
    {
      preHandler: [contentGuard, csrf],
      schema: { body: BulkNovelActionSchema, response: { 200: BulkResultSchema } },
    },
    async (request, reply) => {
      reply.send(await bulkNovels(request.body, requireAdmin(request), request.ip));
    },
  );
  app.get('/admin/novels/export.csv', { preHandler: statsGuard }, async (_request, reply) => {
    sendFile(reply, await exportCatalogCsv());
  });
  app.get<{ Querystring: NovelStatsQuery }>(
    '/admin/novels/stats/top',
    {
      preHandler: statsGuard,
      schema: { querystring: NovelStatsQuerySchema, response: { 200: TopNovelsSchema } },
    },
    async (request, reply) => {
      reply.send(await getTopNovels(request.query.days ?? 30));
    },
  );
  app.get<{ Params: IdParams }>(
    '/admin/novels/:id',
    {
      preHandler: statsGuard,
      schema: { params: IdParamsSchema, response: { 200: AdminNovelSchema } },
    },
    async (request, reply) => {
      reply.send(await getAdminNovel(request.params.id));
    },
  );
  app.post<{ Params: IdParams; Body: UpdateNovelInput }>(
    '/admin/novels/:id',
    {
      preHandler: [contentGuard, csrf],
      schema: {
        params: IdParamsSchema,
        body: UpdateNovelSchema,
        response: { 200: AdminNovelSchema },
      },
    },
    async (request, reply) => {
      reply.send(
        await updateNovel(request.params.id, request.body, requireAdmin(request), request.ip),
      );
    },
  );
  app.delete<{ Params: IdParams }>(
    '/admin/novels/:id',
    { preHandler: [contentGuard, csrf], schema: { params: IdParamsSchema } },
    async (request, reply) => {
      reply.send(await deleteNovel(request.params.id, requireAdmin(request), request.ip));
    },
  );
  app.get<{ Params: IdParams; Querystring: NovelStatsQuery }>(
    '/admin/novels/:id/stats',
    {
      preHandler: statsGuard,
      schema: {
        params: IdParamsSchema,
        querystring: NovelStatsQuerySchema,
        response: { 200: NovelStatsSchema },
      },
    },
    async (request, reply) => {
      reply.send(await getNovelStats(request.params.id, request.query.days ?? 30));
    },
  );
  app.get<{ Params: IdParams; Querystring: { format?: 'json' | 'zip' | 'epub' | 'txt' } }>(
    '/admin/novels/:id/export',
    {
      preHandler: contentGuard,
      schema: { params: IdParamsSchema, querystring: ExportQuerySchema },
    },
    async (request, reply) => {
      sendFile(reply, await exportNovel(request.params.id, request.query.format ?? 'zip'));
    },
  );

  // ---- Chapters ----
  app.get<{ Params: IdParams; Querystring: AdminChapterListQuery }>(
    '/admin/novels/:id/chapters',
    {
      preHandler: statsGuard,
      schema: {
        params: IdParamsSchema,
        querystring: AdminChapterListQuerySchema,
        response: { 200: AdminChapterListSchema },
      },
    },
    async (request, reply) => {
      reply.send(await listAdminChapters(request.params.id, request.query));
    },
  );
  app.post<{ Params: IdParams; Body: CreateChapterInput }>(
    '/admin/novels/:id/chapters',
    {
      preHandler: [contentGuard, csrf],
      // A chapter body can be far larger than the default 1 MiB JSON limit once escaped.
      bodyLimit: 4 * 1024 * 1024,
      schema: {
        params: IdParamsSchema,
        body: CreateChapterSchema,
        response: { 200: AdminChapterSchema },
      },
    },
    async (request, reply) => {
      reply.send(
        await createChapter(request.params.id, request.body, requireAdmin(request), request.ip),
      );
    },
  );
  app.post<{ Params: IdParams; Body: BulkChapterAction }>(
    '/admin/novels/:id/chapters/bulk',
    {
      preHandler: [contentGuard, csrf],
      schema: {
        params: IdParamsSchema,
        body: BulkChapterActionSchema,
        response: { 200: BulkResultSchema },
      },
    },
    async (request, reply) => {
      reply.send(
        await bulkChapters(request.params.id, request.body, requireAdmin(request), request.ip),
      );
    },
  );
  app.post<{ Params: IdParams }>(
    '/admin/novels/:id/chapters/renumber',
    {
      preHandler: [contentGuard, csrf],
      schema: { params: IdParamsSchema, response: { 200: RenumberResultSchema } },
    },
    async (request, reply) => {
      reply.send(await renumberChapters(request.params.id, requireAdmin(request), request.ip));
    },
  );
  app.get<{ Params: ChapterIdParams }>(
    '/admin/novels/:id/chapters/:chapter_id',
    {
      preHandler: statsGuard,
      schema: { params: ChapterIdParamsSchema, response: { 200: AdminChapterSchema } },
    },
    async (request, reply) => {
      reply.send(await getAdminChapter(request.params.id, request.params.chapter_id));
    },
  );
  app.post<{ Params: ChapterIdParams; Body: UpdateChapterInput }>(
    '/admin/novels/:id/chapters/:chapter_id',
    {
      preHandler: [contentGuard, csrf],
      bodyLimit: 4 * 1024 * 1024,
      schema: {
        params: ChapterIdParamsSchema,
        body: UpdateChapterSchema,
        response: { 200: AdminChapterSchema },
      },
    },
    async (request, reply) => {
      reply.send(
        await updateChapter(
          request.params.id,
          request.params.chapter_id,
          request.body,
          requireAdmin(request),
          request.ip,
        ),
      );
    },
  );
  app.delete<{ Params: ChapterIdParams }>(
    '/admin/novels/:id/chapters/:chapter_id',
    { preHandler: [contentGuard, csrf], schema: { params: ChapterIdParamsSchema } },
    async (request, reply) => {
      reply.send(
        await deleteChapter(
          request.params.id,
          request.params.chapter_id,
          requireAdmin(request),
          request.ip,
        ),
      );
    },
  );
  app.get<{ Params: ChapterIdParams }>(
    '/admin/novels/:id/chapters/:chapter_id/revisions',
    {
      preHandler: contentGuard,
      schema: { params: ChapterIdParamsSchema, response: { 200: ChapterRevisionListSchema } },
    },
    async (request, reply) => {
      reply.send(await listRevisions(request.params.id, request.params.chapter_id));
    },
  );
  app.post<{ Params: RevisionParams }>(
    '/admin/novels/:id/chapters/:chapter_id/revisions/:revision_id/restore',
    {
      preHandler: [contentGuard, csrf],
      schema: { params: RevisionParamsSchema, response: { 200: AdminChapterSchema } },
    },
    async (request, reply) => {
      reply.send(
        await restoreRevision(
          request.params.id,
          request.params.chapter_id,
          request.params.revision_id,
          requireAdmin(request),
          request.ip,
        ),
      );
    },
  );

  // ---- Settings ----
  app.get(
    '/admin/novel/settings',
    { preHandler: settingsGuard, schema: { response: { 200: NovelSettingsListSchema } } },
    async (_request, reply) => {
      reply.send(await listNovelSettings());
    },
  );
  app.put<{ Params: { region_id: string }; Body: UpdateNovelRegionSettings }>(
    '/admin/novel/settings/:region_id',
    {
      preHandler: [settingsGuard, csrf],
      schema: {
        params: RegionParamsSchema,
        body: UpdateNovelRegionSettingsSchema,
        response: { 200: NovelRegionSettingsSchema },
      },
    },
    async (request, reply) => {
      reply.send(
        await updateNovelSettings(
          request.params.region_id,
          request.body,
          requireAdmin(request),
          request.ip,
        ),
      );
    },
  );

  // ---- Imports ----
  app.get<{ Querystring: ImportJobListQuery }>(
    '/admin/novel-imports',
    {
      preHandler: contentGuard,
      schema: { querystring: ImportJobListQuerySchema, response: { 200: ImportJobListSchema } },
    },
    async (request, reply) => {
      reply.send(await listImportJobs(request.query.limit ?? 30));
    },
  );
  app.get<{ Params: IdParams }>(
    '/admin/novel-imports/:id',
    {
      preHandler: contentGuard,
      schema: { params: IdParamsSchema, response: { 200: ImportJobSchema } },
    },
    async (request, reply) => {
      reply.send(await getImportJob(request.params.id));
    },
  );
  app.get<{ Params: IdParams; Querystring: ImportChaptersQuery }>(
    '/admin/novel-imports/:id/chapters',
    {
      preHandler: contentGuard,
      schema: {
        params: IdParamsSchema,
        querystring: ImportChaptersQuerySchema,
        response: { 200: ImportChapterPageSchema },
      },
    },
    async (request, reply) => {
      reply.send(
        await listImportChapters(
          request.params.id,
          request.query.novel_index ?? 0,
          request.query.after ?? 0,
          request.query.limit ?? 100,
        ),
      );
    },
  );
  app.post<{ Params: IdParams; Body: CommitImportInput }>(
    '/admin/novel-imports/:id/commit',
    {
      preHandler: [contentGuard, csrf],
      schema: {
        params: IdParamsSchema,
        body: CommitImportSchema,
        response: { 200: ImportJobSchema },
      },
    },
    async (request, reply) => {
      reply.send(
        await commitImportJob(request.params.id, request.body, requireAdmin(request), request.ip),
      );
    },
  );
  app.post<{ Params: IdParams }>(
    '/admin/novel-imports/:id/cancel',
    {
      preHandler: [contentGuard, csrf],
      schema: { params: IdParamsSchema, response: { 200: ImportJobSchema } },
    },
    async (request, reply) => {
      reply.send(await cancelImportJob(request.params.id, requireAdmin(request), request.ip));
    },
  );

  // ---- AI covers ----
  // One render per job in the worker, applied to the novel as soon as it exists. The apply route
  // re-applies an earlier job's image (or an import draft that did not replace an existing cover).
  app.post<{ Params: IdParams; Body: CreateCoverJobInput }>(
    '/admin/novels/:id/cover-jobs',
    {
      preHandler: [contentGuard, csrf],
      schema: {
        params: IdParamsSchema,
        body: CreateCoverJobSchema,
        response: { 202: CoverJobSchema },
      },
    },
    async (request, reply) => {
      const actor = requireAdmin(request);
      // Each job is one LLM call and a paid render.
      await checkSubjectRateLimit('cover-ai', actor.id, 3600, 30);
      // Blank after trimming means "let the LLM write it"; createCoverJob treats '' as absent.
      const prompt = request.body.prompt?.trim();
      reply.code(202).send(await createCoverJob(request.params.id, actor, 'manual', prompt));
    },
  );

  app.get<{ Params: IdParams }>(
    '/admin/novels/:id/cover-jobs/latest',
    {
      preHandler: contentGuard,
      schema: { params: IdParamsSchema, response: { 200: LatestCoverJobSchema } },
    },
    async (request, reply) => {
      reply.send(await getLatestCoverJob(request.params.id));
    },
  );

  app.post<{ Params: IdParams }>(
    '/admin/novel-cover-candidates/:id/apply',
    {
      preHandler: [contentGuard, csrf],
      schema: { params: IdParamsSchema, response: { 200: AdminNovelSchema } },
    },
    async (request, reply) => {
      reply.send(await applyCoverCandidate(request.params.id, requireAdmin(request), request.ip));
    },
  );

  // Multipart only exists inside this scope: no other route accepts file uploads.
  void app.register(async (uploads) => {
    await uploads.register(multipart, {
      limits: { files: 1, fields: 10, fieldSize: 1024, fileSize: MAX_IMPORT_BYTES, parts: 12 },
    });

    uploads.post<{ Params: IdParams }>(
      '/admin/novels/:id/cover',
      {
        preHandler: [contentGuard, csrf],
        schema: { params: IdParamsSchema, response: { 200: AdminNovelSchema } },
      },
      async (request, reply) => {
        const file = await request.file({ limits: { fileSize: MAX_COVER_BYTES } });
        if (!file) throw new AppError('FILE_REQUIRED', 'Upload an image file', 400);
        const data = await file.toBuffer();
        const type = detectImageType(data);
        if (!type)
          throw new AppError('UNSUPPORTED_IMAGE', 'Cover must be a JPEG, PNG or WebP image', 400);
        const storage = getObjectStorage();
        const key = `covers/${request.params.id}/${uuidv7()}.${type.ext}`;
        await storage.put(key, data, type.contentType);
        const result = await setNovelCover(
          request.params.id,
          { url: storage.publicUrl(key), key },
          requireAdmin(request),
          request.ip,
        );
        if (result.previousKey) void storage.delete(result.previousKey).catch(() => undefined);
        reply.send(result.novel);
      },
    );

    uploads.post(
      '/admin/novel-imports',
      { preHandler: [contentGuard, csrf], schema: { response: { 200: ImportJobSchema } } },
      async (request, reply) => {
        const file = await request.file();
        if (!file) throw new AppError('FILE_REQUIRED', 'Upload a file to import', 400);
        const data = await file.toBuffer();
        // Fields sent before the file part are available here; the CMS sends them first.
        const fields = file.fields as Record<string, unknown>;
        const format = fieldValue(fields, 'format');
        const mode = fieldValue(fields, 'mode') ?? 'new';
        if (format && !IMPORT_FORMATS.includes(format as NovelImportFormat)) {
          throw new AppError('UNSUPPORTED_FORMAT', 'Unsupported import format', 400);
        }
        if (!IMPORT_MODES.includes(mode as NovelImportMode)) {
          throw new AppError('INVALID_MODE', 'mode must be new, append or replace', 400);
        }
        reply.send(
          await createImportJob(
            {
              filename: file.filename,
              data,
              format: format as NovelImportFormat | undefined,
              mode: mode as NovelImportMode,
              targetNovelId: fieldValue(fields, 'target_novel_id'),
              chapterPattern: fieldValue(fields, 'chapter_pattern'),
            },
            requireAdmin(request),
            request.ip,
          ),
        );
      },
    );
  });
}
