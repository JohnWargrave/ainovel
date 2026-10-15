import { randomInt } from 'node:crypto';
import { sql } from 'kysely';
import type pino from 'pino';
import { uuidv7 } from 'uuidv7';
import { env } from '../../../config/env.js';
import { db } from '../../../db/index.js';
import { AppError } from '../../../lib/errors.js';
import { getNovelCoverQueue } from '../../../jobs/novel-cover.js';
import { insertAudit, setNovelCover, type NovelActor } from '../admin.service.js';
import type { AdminNovel } from '../admin-schemas.js';
import { getObjectStorage } from '../storage.js';
import { EXCERPT_CHARS, getCoverBriefWriter, manualBrief, type CoverBrief } from './brief.js';
import { COVER_HEIGHT, COVER_WIDTH, composeCover } from './compose.js';
import { getCoverImageGenerator } from './image-generator.js';

export const CANDIDATES_PER_JOB = 4;
// A worker that died mid-job leaves it `generating`, and the one-running-job index would then
// block the novel for good. Nothing legitimate runs this long (four renders are ~1 minute).
const STALE_JOB_MINUTES = 15;

export interface CoverCandidate {
  id: string;
  idx: number;
  url: string;
  clean_url: string;
  applied_at: string | null;
}

export interface CoverJob {
  id: string;
  novel_id: string;
  status: string;
  trigger: string;
  prompt: string | null;
  brief: CoverBrief | null;
  model: string | null;
  errors: string[];
  created_at: string;
  finished_at: string | null;
  candidates: CoverCandidate[];
}

export function isCoverAiConfigured(): boolean {
  try {
    getCoverImageGenerator();
    getCoverBriefWriter();
    return true;
  } catch {
    return false;
  }
}

async function failStaleJobs(novelId: string): Promise<void> {
  await db
    .updateTable('novel_cover_jobs')
    .set({
      status: 'failed',
      errors: JSON.stringify(['Generation did not finish']),
      finished_at: new Date(),
    })
    .where('novel_id', '=', novelId)
    .where('status', 'in', ['queued', 'generating'])
    .where('created_at', '<', sql<Date>`now() - make_interval(mins => ${STALE_JOB_MINUTES})`)
    .execute();
}

export async function createCoverJob(
  novelId: string,
  actor: NovelActor | null,
  trigger: 'manual' | 'import',
  typedPrompt?: string,
): Promise<CoverJob> {
  const prompt = typedPrompt?.trim() === '' ? undefined : typedPrompt?.trim();
  // Fail here, in the request, rather than in the worker after the admin has started waiting.
  getCoverImageGenerator();
  if (!prompt) getCoverBriefWriter();

  const novel = await db
    .selectFrom('novels')
    .select('id')
    .where('id', '=', novelId)
    .executeTakeFirst();
  if (!novel) throw new AppError('NOVEL_NOT_FOUND', 'Novel not found', 404);

  await failStaleJobs(novelId);
  const id = uuidv7();
  try {
    await db
      .insertInto('novel_cover_jobs')
      .values({
        id,
        novel_id: novelId,
        trigger,
        admin_user_id: actor?.id ?? null,
        brief: prompt ? JSON.stringify(manualBrief(prompt)) : null,
        prompt: prompt ?? null,
      })
      .execute();
  } catch (err) {
    if (
      err instanceof Error &&
      'constraint' in err &&
      err.constraint === 'novel_cover_jobs_running_uniq'
    ) {
      throw new AppError(
        'COVER_JOB_IN_PROGRESS',
        'Covers for this novel are already being generated',
        409,
      );
    }
    throw err;
  }
  await getNovelCoverQueue().add(
    'generate',
    { jobId: id },
    { attempts: 1, removeOnComplete: 1000 },
  );
  return getCoverJob(id);
}

async function readNovelForBrief(novelId: string): Promise<{
  title: string;
  author: string | null;
  description: string | null;
  tags: string[];
  genres: string[];
  excerpt: string;
}> {
  const novel = await db
    .selectFrom('novels')
    .select(['title', 'author', 'description', 'tags'])
    .where('id', '=', novelId)
    .executeTakeFirst();
  if (!novel) throw new AppError('NOVEL_NOT_FOUND', 'Novel not found', 404);
  const genres = await db
    .selectFrom('novel_category_links')
    .innerJoin('novel_categories', 'novel_categories.id', 'novel_category_links.category_id')
    .select('novel_categories.name')
    .where('novel_category_links.novel_id', '=', novelId)
    .execute();
  // Cut in SQL: a chapter can be hundreds of KB and only the opening matters.
  const chapters = await db
    .selectFrom('novel_chapters')
    .select(sql<string>`left(content, ${EXCERPT_CHARS})`.as('content'))
    .where('novel_id', '=', novelId)
    .orderBy('chapter_no')
    .limit(2)
    .execute();
  return {
    title: novel.title,
    author: novel.author,
    description: novel.description,
    tags: novel.tags,
    genres: genres.map((genre) => genre.name),
    excerpt: chapters
      .map((chapter) => chapter.content)
      .join('\n\n')
      .slice(0, EXCERPT_CHARS),
  };
}

function publicMessage(err: unknown, fallback: string): string {
  return err instanceof AppError ? err.message : fallback;
}

export async function processCoverJob(jobId: string, logger?: pino.Logger): Promise<void> {
  const claimed = await db
    .updateTable('novel_cover_jobs')
    .set({ status: 'generating' })
    .where('id', '=', jobId)
    .where('status', '=', 'queued')
    .returningAll()
    .executeTakeFirst();
  if (!claimed) return;
  const errors: string[] = [];
  try {
    const generator = getCoverImageGenerator();
    const storage = getObjectStorage();
    const novel = await readNovelForBrief(claimed.novel_id);
    const brief = claimed.brief
      ? (claimed.brief as CoverBrief)
      : await getCoverBriefWriter().write(novel);
    await db
      .updateTable('novel_cover_jobs')
      .set({ brief: JSON.stringify(brief), prompt: brief.prompt, model: generator.model })
      .where('id', '=', jobId)
      .execute();

    // One at a time, each saved as soon as it exists, so the CMS shows candidates as they land and
    // one refused or timed-out render costs one slot, not the job.
    let made = 0;
    for (let idx = 0; idx < CANDIDATES_PER_JOB; idx += 1) {
      const seed = randomInt(0, 2 ** 31);
      try {
        const raw = await generator.generate({
          prompt: brief.prompt,
          seed,
          width: COVER_WIDTH,
          height: COVER_HEIGHT,
        });
        const cover = await composeCover(raw, { title: novel.title, author: novel.author });
        const imageKey = `covers/candidates/${jobId}/${String(idx)}.webp`;
        const cleanKey = `covers/candidates/${jobId}/${String(idx)}-clean.webp`;
        await storage.put(imageKey, cover.withText, 'image/webp');
        await storage.put(cleanKey, cover.clean, 'image/webp');
        await db
          .insertInto('novel_cover_candidates')
          .values({
            id: uuidv7(),
            job_id: jobId,
            idx,
            seed,
            image_key: imageKey,
            clean_key: cleanKey,
          })
          .execute();
        made += 1;
      } catch (err) {
        logger?.warn({ err, jobId, idx }, 'cover candidate failed');
        errors.push(publicMessage(err, 'An image could not be generated'));
      }
    }
    if (made === 0)
      throw new AppError('COVER_AI_NO_IMAGES', errors[0] ?? 'No image was generated', 502);
    await db
      .updateTable('novel_cover_jobs')
      .set({ status: 'ready', errors: JSON.stringify(errors), finished_at: new Date() })
      .where('id', '=', jobId)
      .execute();
  } catch (err) {
    logger?.error({ err, jobId }, 'cover generation failed');
    await db
      .updateTable('novel_cover_jobs')
      .set({
        status: 'failed',
        errors: JSON.stringify([publicMessage(err, 'Cover generation failed')]),
        finished_at: new Date(),
      })
      .where('id', '=', jobId)
      .execute();
  }
}

async function serialize(row: {
  id: string;
  novel_id: string;
  status: string;
  trigger: string;
  brief: unknown;
  prompt: string | null;
  model: string | null;
  errors: unknown;
  created_at: Date;
  finished_at: Date | null;
}): Promise<CoverJob> {
  const storage = getObjectStorage();
  const candidates = await db
    .selectFrom('novel_cover_candidates')
    .select(['id', 'idx', 'image_key', 'clean_key', 'applied_at'])
    .where('job_id', '=', row.id)
    .orderBy('idx')
    .execute();
  return {
    id: row.id,
    novel_id: row.novel_id,
    status: row.status,
    trigger: row.trigger,
    prompt: row.prompt,
    brief: (row.brief as CoverBrief | null) ?? null,
    model: row.model,
    errors: Array.isArray(row.errors) ? (row.errors as unknown[]).map(String) : [],
    created_at: new Date(row.created_at).toISOString(),
    finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      idx: candidate.idx,
      url: storage.publicUrl(candidate.image_key),
      clean_url: storage.publicUrl(candidate.clean_key),
      applied_at: candidate.applied_at ? new Date(candidate.applied_at).toISOString() : null,
    })),
  };
}

export async function getCoverJob(id: string): Promise<CoverJob> {
  const row = await db
    .selectFrom('novel_cover_jobs')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw new AppError('COVER_JOB_NOT_FOUND', 'Cover job not found', 404);
  return serialize(row);
}

export async function getLatestCoverJob(novelId: string): Promise<{ job: CoverJob | null }> {
  const row = await db
    .selectFrom('novel_cover_jobs')
    .selectAll()
    .where('novel_id', '=', novelId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return { job: row ? await serialize(row) : null };
}

export async function applyCoverCandidate(
  candidateId: string,
  actor: NovelActor,
  ip: string,
): Promise<AdminNovel> {
  const candidate = await db
    .selectFrom('novel_cover_candidates')
    .innerJoin('novel_cover_jobs', 'novel_cover_jobs.id', 'novel_cover_candidates.job_id')
    .select([
      'novel_cover_candidates.id',
      'novel_cover_candidates.job_id',
      'novel_cover_candidates.image_key',
      'novel_cover_jobs.novel_id',
      'novel_cover_jobs.status',
    ])
    .where('novel_cover_candidates.id', '=', candidateId)
    .executeTakeFirst();
  if (!candidate) throw new AppError('COVER_CANDIDATE_NOT_FOUND', 'Cover candidate not found', 404);
  if (candidate.status !== 'ready' && candidate.status !== 'applied') {
    throw new AppError('COVER_JOB_NOT_READY', `Cover job is ${candidate.status}`, 409);
  }

  // Candidates expire (bucket lifecycle on covers/candidates/), so the chosen one gets a permanent
  // key of its own, the same shape an uploaded cover has.
  const storage = getObjectStorage();
  const key = `covers/${candidate.novel_id}/${uuidv7()}.webp`;
  await storage.put(key, await storage.get(candidate.image_key), 'image/webp');
  const { previousKey, novel } = await setNovelCover(
    candidate.novel_id,
    { url: storage.publicUrl(key), key },
    actor,
    ip,
  );
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('novel_cover_candidates')
      .set({ applied_at: new Date() })
      .where('id', '=', candidate.id)
      .execute();
    await trx
      .updateTable('novel_cover_jobs')
      .set({ status: 'applied' })
      .where('id', '=', candidate.job_id)
      .execute();
    await insertAudit(
      trx,
      actor,
      'NOVEL_COVER_AI_APPLIED',
      'novel',
      candidate.novel_id,
      { job_id: candidate.job_id, candidate_id: candidate.id, key },
      ip,
    );
  });
  if (previousKey && previousKey !== key) {
    storage.delete(previousKey).catch(() => undefined);
  }
  return novel;
}

// Draft covers for novels an import just created without one. Never fails the import: a missing
// key or a busy novel only means no draft.
export async function draftCoversForImport(
  novelIds: string[],
  logger?: pino.Logger,
): Promise<void> {
  if (!env.COVER_AI_AUTO_ON_IMPORT || novelIds.length === 0 || !isCoverAiConfigured()) return;
  const bare = await db
    .selectFrom('novels')
    .select('id')
    .where('id', 'in', novelIds)
    .where('cover_key', 'is', null)
    .execute();
  for (const novel of bare) {
    await createCoverJob(novel.id, null, 'import').catch((err: unknown) => {
      logger?.warn({ err, novelId: novel.id }, 'could not queue import cover draft');
    });
  }
}
