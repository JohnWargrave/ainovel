// Catalog browsing and playback tokens only. Watch-to-earn lives in heartbeat.service.ts — the
// former POST /drama/episodes/:id/watch credited on an unverified client-supplied watched_seconds
// and has been removed rather than deprecated, so the new verification cannot be bypassed.
import { createHmac } from 'node:crypto';
import { db } from '../../db/index.js';
import { sql } from 'kysely';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

const TOKEN_TTL_MS = 5 * 60 * 1000;

function playbackToken(userId: string, episodeId: string, expiresAt: number): string {
  const secret = env.DRAMA_PLAYBACK_SECRET;
  if (!secret) throw new AppError('CONFIGURATION_ERROR', 'Drama playback is not configured', 503);
  const payload = `${userId}:${episodeId}:${String(expiresAt)}`;
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

async function userCountry(userId: string): Promise<string> {
  const user = await db
    .selectFrom('users')
    .select(['country_code', 'status'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
  if (user.status !== 'active')
    throw new AppError('EARNING_BLOCKED', 'User is not in good standing to earn', 403);
  return user.country_code;
}

// The return shape is intentionally inferred from Kysely's selected columns.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function listSeries(userId: string) {
  const country = await userCountry(userId);
  const rows = await db
    .selectFrom('drama_series')
    .select(['id', 'title', 'description', 'cover_url', 'total_episodes'])
    .where('status', '=', 'live')
    .where(sql<boolean>`(license_expires is null or license_expires >= current_date)`)
    .where(sql<boolean>`${country} = any(license_regions)`)
    .orderBy('created_at', 'desc')
    .execute();
  return rows;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function getSeries(userId: string, seriesId: string) {
  const country = await userCountry(userId);
  const series = await db
    .selectFrom('drama_series')
    .selectAll()
    .where('id', '=', seriesId)
    .where('status', '=', 'live')
    .where(sql<boolean>`${country} = any(license_regions)`)
    .executeTakeFirst();
  if (
    !series ||
    (series.license_expires !== null && new Date(series.license_expires) < new Date())
  ) {
    throw new AppError('NOT_FOUND', 'Drama series not found', 404);
  }
  const episodes = await db
    .selectFrom('drama_episodes')
    .select(['id', 'episode_no', 'duration_s'])
    .where('series_id', '=', seriesId)
    .orderBy('episode_no', 'asc')
    .execute();
  return { series, episodes };
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export async function issuePlayback(userId: string, episodeId: string) {
  const country = await userCountry(userId);
  const row = await db
    .selectFrom('drama_episodes')
    .innerJoin('drama_series', 'drama_series.id', 'drama_episodes.series_id')
    .select([
      'drama_episodes.id',
      'drama_episodes.byteplus_vid',
      'drama_series.license_regions',
      'drama_series.status',
      'drama_series.license_expires',
    ])
    .where('drama_episodes.id', '=', episodeId)
    .executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'Episode not found', 404);
  if (
    row.status !== 'live' ||
    !row.license_regions.includes(country) ||
    (row.license_expires !== null && new Date(row.license_expires) < new Date())
  ) {
    throw new AppError('NOT_FOUND', 'Episode not available in this region', 404);
  }
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const token = playbackToken(userId, episodeId, expiresAt);
  const base = env.DRAMA_PLAYBACK_BASE_URL ?? 'https://vod.invalid/play';
  return {
    episode_id: episodeId,
    playback_url: `${base}/${encodeURIComponent(row.byteplus_vid)}?token=${token}`,
    expires_at: new Date(expiresAt).toISOString(),
  };
}
