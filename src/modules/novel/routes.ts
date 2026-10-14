import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import type { AuthDeps } from '../auth/auth.service.js';
import { AppError } from '../../lib/errors.js';
import { checkSubjectRateLimit } from '../../lib/rate-limit.js';
import {
  CategoryListResponseSchema,
  ChapterParamsSchema,
  ChapterReadResponseSchema,
  ChapterTocResponseSchema,
  HomeResponseSchema,
  LibraryQuerySchema,
  LibraryResponseSchema,
  ListChaptersQuerySchema,
  ListNovelsQuerySchema,
  NovelDetailSchema,
  NovelListResponseSchema,
  NovelParamsSchema,
  ReadChapterParamsSchema,
  ReadHeartbeatBodySchema,
  ReadHeartbeatResponseSchema,
  UnlockBodySchema,
  UnlockResponseSchema,
  type ChapterParams,
  type LibraryQuery,
  type ListChaptersQuery,
  type ListNovelsQuery,
  type NovelParams,
  type ReadChapterParams,
  type ReadHeartbeatBody,
  type UnlockBody,
} from './schemas.js';
import {
  getHome,
  getLibrary,
  getNovel,
  listCategories,
  listChapters,
  listNovels,
  readChapter,
  setBookshelf,
} from './novel.service.js';
import { recordReadHeartbeat } from './reading.service.js';
import { unlockChapter } from './unlock.service.js';

// Chapter bodies are the product: these budgets are what stops one account from scraping a whole
// catalogue, while staying far above what a person reads.
const CHAPTER_READ_PER_MINUTE = 20;
const CHAPTER_READ_PER_HOUR = 300;

function userId(request: FastifyRequest): string {
  if (!request.authUser) throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
  return request.authUser.sub;
}

export function registerNovelRoutes(app: FastifyInstance, deps: Pick<AuthDeps, 'accessJwt'>): void {
  const authGuard = createAuthGuard(deps.accessJwt);

  app.get<{ Querystring: ListNovelsQuery }>(
    '/novels',
    {
      preHandler: authGuard,
      schema: { querystring: ListNovelsQuerySchema, response: { 200: NovelListResponseSchema } },
    },
    async (request, reply) => {
      reply.send(await listNovels(userId(request), request.query));
    },
  );

  app.get(
    '/novels/home',
    { preHandler: authGuard, schema: { response: { 200: HomeResponseSchema } } },
    async (request, reply) => {
      reply.send(await getHome(userId(request)));
    },
  );

  app.get(
    '/novels/categories',
    { preHandler: authGuard, schema: { response: { 200: CategoryListResponseSchema } } },
    async (request, reply) => {
      userId(request);
      reply.send(await listCategories());
    },
  );

  app.get<{ Params: NovelParams }>(
    '/novels/:id',
    {
      preHandler: authGuard,
      schema: { params: NovelParamsSchema, response: { 200: NovelDetailSchema } },
    },
    async (request, reply) => {
      reply.send(await getNovel(userId(request), request.params.id));
    },
  );

  app.get<{ Params: NovelParams; Querystring: ListChaptersQuery }>(
    '/novels/:id/chapters',
    {
      preHandler: authGuard,
      schema: {
        params: NovelParamsSchema,
        querystring: ListChaptersQuerySchema,
        response: { 200: ChapterTocResponseSchema },
      },
    },
    async (request, reply) => {
      reply.send(await listChapters(userId(request), request.params.id, request.query));
    },
  );

  app.get<{ Params: ReadChapterParams }>(
    '/novels/:id/chapters/:chapter_no',
    {
      preHandler: authGuard,
      schema: { params: ReadChapterParamsSchema, response: { 200: ChapterReadResponseSchema } },
    },
    async (request, reply) => {
      const sub = userId(request);
      await checkSubjectRateLimit('novel-chapter-read-min', sub, 60, CHAPTER_READ_PER_MINUTE);
      await checkSubjectRateLimit(
        'novel-chapter-read-hour',
        sub,
        3600,
        CHAPTER_READ_PER_HOUR,
        'CHAPTER_HOURLY_LIMIT',
      );
      reply.send(await readChapter(sub, request.params.id, request.params.chapter_no));
    },
  );

  app.post<{ Params: ChapterParams; Body: UnlockBody }>(
    '/novels/chapters/:id/unlock',
    {
      preHandler: authGuard,
      schema: {
        params: ChapterParamsSchema,
        body: UnlockBodySchema,
        response: { 200: UnlockResponseSchema },
      },
    },
    async (request, reply) => {
      const sub = userId(request);
      await checkSubjectRateLimit('novel-chapter-unlock', sub, 60, 30);
      reply.send(await unlockChapter(sub, request.params.id, request.body));
    },
  );

  app.post<{ Body: ReadHeartbeatBody }>(
    '/novels/read-heartbeat',
    {
      preHandler: authGuard,
      schema: { body: ReadHeartbeatBodySchema, response: { 200: ReadHeartbeatResponseSchema } },
    },
    async (request, reply) => {
      const sub = userId(request);
      // A ~10s beat is 6/min; 20 leaves room for retries and chapter switches.
      await checkSubjectRateLimit('novel-read-heartbeat', sub, 60, 20);
      reply.send(await recordReadHeartbeat(sub, request.body));
    },
  );

  app.get<{ Querystring: LibraryQuery }>(
    '/library',
    {
      preHandler: authGuard,
      schema: { querystring: LibraryQuerySchema, response: { 200: LibraryResponseSchema } },
    },
    async (request, reply) => {
      reply.send(await getLibrary(userId(request), request.query));
    },
  );

  app.put<{ Params: NovelParams }>(
    '/library/:id',
    { preHandler: authGuard, schema: { params: NovelParamsSchema } },
    async (request, reply) => {
      reply.send(await setBookshelf(userId(request), request.params.id, true));
    },
  );

  app.delete<{ Params: NovelParams }>(
    '/library/:id',
    { preHandler: authGuard, schema: { params: NovelParamsSchema } },
    async (request, reply) => {
      reply.send(await setBookshelf(userId(request), request.params.id, false));
    },
  );
}
