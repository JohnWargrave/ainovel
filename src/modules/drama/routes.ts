import type { FastifyInstance } from 'fastify';
import { createAuthGuard } from '../../plugins/auth-guard.js';
import type { AuthDeps } from '../auth/auth.service.js';
import { AppError } from '../../lib/errors.js';
import { checkSubjectRateLimit } from '../../lib/rate-limit.js';
import {
  EpisodeParamsSchema,
  SeriesListResponseSchema,
  SeriesParamsSchema,
  PlaybackResponseSchema,
  WatchHeartbeatBodySchema,
  WatchHeartbeatResponseSchema,
  type EpisodeParams,
  type SeriesParams,
  type WatchHeartbeatBody,
} from './schemas.js';
import { getSeries, issuePlayback, listSeries } from './drama.service.js';
import { recordWatchHeartbeat } from './heartbeat.service.js';

export function registerDramaRoutes(app: FastifyInstance, deps: Pick<AuthDeps, 'accessJwt'>): void {
  const authGuard = createAuthGuard(deps.accessJwt);
  app.get(
    '/drama/series',
    { preHandler: authGuard, schema: { response: { 200: SeriesListResponseSchema } } },
    async (request, reply) => {
      if (!request.authUser) throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      reply.send({ items: await listSeries(request.authUser.sub) });
    },
  );
  app.get<{ Params: SeriesParams }>(
    '/drama/series/:id',
    { preHandler: authGuard, schema: { params: SeriesParamsSchema } },
    async (request, reply) => {
      if (!request.authUser) throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      const result = await getSeries(request.authUser.sub, request.params.id);
      reply.send({
        id: result.series.id,
        title: result.series.title,
        description: result.series.description,
        cover_url: result.series.cover_url,
        total_episodes: result.series.total_episodes,
        episodes: result.episodes,
      });
    },
  );
  app.post<{ Params: EpisodeParams }>(
    '/drama/episodes/:id/playback',
    {
      preHandler: authGuard,
      schema: { params: EpisodeParamsSchema, response: { 200: PlaybackResponseSchema } },
    },
    async (request, reply) => {
      if (!request.authUser) throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      reply.send(await issuePlayback(request.authUser.sub, request.params.id));
    },
  );
  app.post<{ Body: WatchHeartbeatBody }>(
    '/drama/watch-heartbeat',
    {
      preHandler: authGuard,
      schema: {
        body: WatchHeartbeatBodySchema,
        response: { 200: WatchHeartbeatResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.authUser) throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
      // A ~5s beat is 12/min. 30 leaves room for retries and for switching episodes without the
      // player tripping the limit during normal use.
      await checkSubjectRateLimit('drama-heartbeat', request.authUser.sub, 60, 30);
      reply.send(await recordWatchHeartbeat(request.authUser.sub, request.body));
    },
  );
}
