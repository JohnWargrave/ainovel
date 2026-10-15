import { uuidv7 } from 'uuidv7';
import type pino from 'pino';
import type { Transaction } from 'kysely';
import { db } from '../../../db/index.js';
import type { DB, NovelImportFormat, NovelImportMode } from '../../../db/types.js';
import { AppError } from '../../../lib/errors.js';
import { getNovelImportQueue } from '../../../jobs/novel-import.js';
import {
  createNovelInTransaction,
  insertAudit,
  refreshNovelCounters,
  type NovelActor,
} from '../admin.service.js';
import { draftCoversForImport } from '../cover-ai/service.js';
import { getObjectStorage } from '../storage.js';
import { countWords } from '../text.js';
import { chapterWarnings, formatFromFilename, parseImport } from './parsers.js';
import type { CommitImportInput, ImportJob, ImportChapterPage } from './import-schemas.js';

type Trx = Transaction<DB>;

const INSERT_BATCH_SIZE = 200;
const EXCERPT_LENGTH = 200;

interface PreviewNovel {
  index: number;
  title: string;
  author: string | null;
  description: string | null;
  language: string | null;
  tags: string[];
  cover_url: string | null;
  cover_key: string | null;
  chapter_count: number;
  word_count: number;
  warning_count: number;
}

interface Preview {
  novels: PreviewNovel[];
}

function asPreview(value: unknown): Preview {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return { novels: Array.isArray(record['novels']) ? (record['novels'] as PreviewNovel[]) : [] };
}

function serializeJob(row: {
  id: string;
  format: string;
  filename: string;
  mode: string;
  target_novel_id: string | null;
  status: string;
  preview: unknown;
  errors: unknown;
  result_novel_ids: string[];
  created_at: Date;
  finished_at: Date | null;
  admin_email?: string | null;
}): ImportJob {
  return {
    id: row.id,
    format: row.format,
    filename: row.filename,
    mode: row.mode,
    target_novel_id: row.target_novel_id,
    status: row.status,
    preview: row.preview ? asPreview(row.preview) : null,
    errors: Array.isArray(row.errors) ? (row.errors as unknown[]).map(String) : [],
    result_novel_ids: row.result_novel_ids,
    created_by: row.admin_email ?? null,
    created_at: new Date(row.created_at).toISOString(),
    finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  };
}

export interface CreateImportInput {
  filename: string;
  data: Buffer;
  format?: NovelImportFormat | undefined;
  mode: NovelImportMode;
  targetNovelId?: string | undefined;
  chapterPattern?: string | undefined;
}

export async function createImportJob(
  input: CreateImportInput,
  actor: NovelActor,
  ip: string,
): Promise<ImportJob> {
  const format = input.format ?? formatFromFilename(input.filename);
  if (!format) {
    throw new AppError(
      'UNSUPPORTED_FORMAT',
      'Unsupported file type — use .epub, .txt, .md, .docx, .json or .zip',
      400,
    );
  }
  if (input.mode !== 'new' && !input.targetNovelId) {
    throw new AppError('TARGET_REQUIRED', 'target_novel_id is required to append or replace', 400);
  }
  if (input.targetNovelId) {
    const target = await db
      .selectFrom('novels')
      .select('id')
      .where('id', '=', input.targetNovelId)
      .executeTakeFirst();
    if (!target) throw new AppError('NOVEL_NOT_FOUND', 'Target novel not found', 404);
  }
  const storage = getObjectStorage();
  const id = uuidv7();
  const safeName = input.filename.replace(/[^\w.-]+/gu, '_').slice(-120);
  const fileKey = `imports/${id}/${safeName}`;
  await storage.put(fileKey, input.data, 'application/octet-stream');
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('novel_import_jobs')
      .values({
        id,
        admin_user_id: actor.id,
        format,
        filename: input.filename.slice(0, 255),
        file_key: fileKey,
        mode: input.mode,
        target_novel_id: input.targetNovelId ?? null,
        chapter_pattern: input.chapterPattern ?? null,
        preview: null,
        stats: null,
        errors: null,
      })
      .execute();
    await insertAudit(
      trx,
      actor,
      'NOVEL_IMPORT_CREATED',
      'novel_import_job',
      id,
      {
        filename: input.filename,
        format,
        mode: input.mode,
        target_novel_id: input.targetNovelId ?? null,
        bytes: input.data.length,
      },
      ip,
    );
  });
  await getNovelImportQueue().add('parse', { jobId: id }, { attempts: 1, removeOnComplete: 1000 });
  return getImportJob(id);
}

// Runs in the worker. Parses the stored file into novel_import_chapters and a preview; nothing is
// visible to readers until an admin commits the job.
export async function processImportJob(jobId: string, logger?: pino.Logger): Promise<void> {
  const claimed = await db
    .updateTable('novel_import_jobs')
    .set({ status: 'parsing' })
    .where('id', '=', jobId)
    .where('status', '=', 'queued')
    .returningAll()
    .executeTakeFirst();
  if (!claimed) return;
  try {
    if (!claimed.file_key) throw new AppError('IMPORT_FILE_MISSING', 'Import file is missing', 400);
    const storage = getObjectStorage();
    const data = await storage.get(claimed.file_key);
    const fallbackTitle =
      claimed.filename
        .replace(/\.[^.]+$/u, '')
        .replace(/[_-]+/gu, ' ')
        .trim() || 'Untitled';
    const novels = await parseImport(claimed.format, data, {
      chapterPattern: claimed.chapter_pattern,
      fallbackTitle,
    });
    if (novels.length === 0 || novels.every((novel) => novel.chapters.length === 0)) {
      throw new AppError('IMPORT_EMPTY', 'No chapters were found in this file', 400);
    }
    if (claimed.mode !== 'new' && novels.length > 1) {
      throw new AppError(
        'IMPORT_MULTIPLE_NOVELS',
        'Append/replace imports must contain a single novel',
        400,
      );
    }

    const preview: Preview = { novels: [] };
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('novel_import_chapters').where('job_id', '=', jobId).execute();
      for (const [index, novel] of novels.entries()) {
        let coverKey: string | null = null;
        if (novel.cover) {
          coverKey = `covers/import-${jobId}/${String(index)}-${uuidv7()}.${novel.cover.ext}`;
          await storage.put(coverKey, novel.cover.data, novel.cover.contentType);
        }
        const rows = novel.chapters.map((chapter, chapterIndex) => ({
          id: uuidv7(),
          job_id: jobId,
          novel_index: index,
          chapter_no: chapterIndex + 1,
          title: chapter.title.slice(0, 300),
          content: chapter.content,
          word_count: countWords(chapter.content),
          warnings: chapterWarnings(chapter, novel.chapters[chapterIndex - 1]),
        }));
        for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
          await trx
            .insertInto('novel_import_chapters')
            .values(rows.slice(start, start + INSERT_BATCH_SIZE))
            .execute();
        }
        preview.novels.push({
          index,
          title: (novel.title ?? fallbackTitle).slice(0, 300),
          author: novel.author?.slice(0, 200) ?? null,
          description: novel.description?.slice(0, 20000) ?? null,
          language: novel.language?.slice(0, 10) ?? null,
          tags: novel.tags.map((tag) => tag.slice(0, 60)),
          cover_url: coverKey ? storage.publicUrl(coverKey) : null,
          cover_key: coverKey,
          chapter_count: rows.length,
          word_count: rows.reduce((sum, row) => sum + row.word_count, 0),
          warning_count: rows.filter((row) => row.warnings.length > 0).length,
        });
      }
      await trx
        .updateTable('novel_import_jobs')
        .set({ status: 'ready', preview: JSON.stringify(preview), errors: null })
        .where('id', '=', jobId)
        .execute();
    });
  } catch (err) {
    const message = err instanceof AppError ? err.message : 'Could not parse the file';
    logger?.error({ err, jobId }, 'novel import parse failed');
    await db
      .updateTable('novel_import_jobs')
      .set({ status: 'failed', errors: JSON.stringify([message]), finished_at: new Date() })
      .where('id', '=', jobId)
      .execute();
  }
}

export async function getImportJob(id: string): Promise<ImportJob> {
  const row = await db
    .selectFrom('novel_import_jobs')
    .leftJoin('admin_users', 'admin_users.id', 'novel_import_jobs.admin_user_id')
    .selectAll('novel_import_jobs')
    .select('admin_users.email as admin_email')
    .where('novel_import_jobs.id', '=', id)
    .executeTakeFirst();
  if (!row) throw new AppError('IMPORT_NOT_FOUND', 'Import job not found', 404);
  return serializeJob(row);
}

export async function listImportJobs(limit: number): Promise<{ items: ImportJob[] }> {
  const rows = await db
    .selectFrom('novel_import_jobs')
    .leftJoin('admin_users', 'admin_users.id', 'novel_import_jobs.admin_user_id')
    .selectAll('novel_import_jobs')
    .select('admin_users.email as admin_email')
    .orderBy('novel_import_jobs.created_at', 'desc')
    .limit(limit)
    .execute();
  return { items: rows.map(serializeJob) };
}

export async function listImportChapters(
  jobId: string,
  novelIndex: number,
  after: number,
  limit: number,
): Promise<ImportChapterPage> {
  const rows = await db
    .selectFrom('novel_import_chapters')
    .select(['chapter_no', 'title', 'word_count', 'warnings', 'content'])
    .where('job_id', '=', jobId)
    .where('novel_index', '=', novelIndex)
    .where('chapter_no', '>', after)
    .orderBy('chapter_no')
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      chapter_no: row.chapter_no,
      title: row.title,
      word_count: row.word_count,
      warnings: row.warnings,
      excerpt: row.content.slice(0, EXCERPT_LENGTH),
    })),
    next_after: rows.length > limit ? (page[page.length - 1]?.chapter_no ?? null) : null,
  };
}

async function insertChapters(
  trx: Trx,
  novelId: string,
  rows: readonly { title: string; content: string; word_count: number }[],
  firstChapterNo: number,
  status: 'draft' | 'published',
): Promise<void> {
  for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
    await trx
      .insertInto('novel_chapters')
      .values(
        rows.slice(start, start + INSERT_BATCH_SIZE).map((row, offset) => ({
          id: uuidv7(),
          novel_id: novelId,
          chapter_no: firstChapterNo + start + offset,
          title: row.title,
          content: row.content,
          word_count: row.word_count,
          status,
        })),
      )
      .execute();
  }
}

async function replaceChapters(
  trx: Trx,
  novelId: string,
  rows: readonly { chapter_no: number; title: string; content: string; word_count: number }[],
  status: 'draft' | 'published',
  actor: NovelActor,
): Promise<void> {
  const existing = await trx
    .selectFrom('novel_chapters')
    .select(['id', 'chapter_no', 'title', 'content'])
    .where('novel_id', '=', novelId)
    .execute();
  const byNo = new Map(existing.map((row) => [row.chapter_no, row]));
  const inserts: (typeof rows)[number][] = [];
  for (const row of rows) {
    const current = byNo.get(row.chapter_no);
    if (!current) {
      inserts.push(row);
      continue;
    }
    if (current.content === row.content && current.title === row.title) continue;
    await trx
      .insertInto('novel_chapter_revisions')
      .values({
        id: uuidv7(),
        chapter_id: current.id,
        title: current.title,
        content: current.content,
        edited_by: actor.id,
      })
      .execute();
    await trx
      .updateTable('novel_chapters')
      .set({
        title: row.title,
        content: row.content,
        word_count: row.word_count,
        updated_at: new Date(),
      })
      .where('id', '=', current.id)
      .execute();
  }
  for (let start = 0; start < inserts.length; start += INSERT_BATCH_SIZE) {
    await trx
      .insertInto('novel_chapters')
      .values(
        inserts.slice(start, start + INSERT_BATCH_SIZE).map((row) => ({
          id: uuidv7(),
          novel_id: novelId,
          chapter_no: row.chapter_no,
          title: row.title,
          content: row.content,
          word_count: row.word_count,
          status,
        })),
      )
      .execute();
  }
}

export async function commitImportJob(
  jobId: string,
  input: CommitImportInput,
  actor: NovelActor,
  ip: string,
): Promise<ImportJob> {
  // Flip to `committing` first so two admins (or a double click) cannot commit the same job twice.
  const job = await db
    .updateTable('novel_import_jobs')
    .set({ status: 'committing' })
    .where('id', '=', jobId)
    .where('status', '=', 'ready')
    .returningAll()
    .executeTakeFirst();
  if (!job) {
    const exists = await db
      .selectFrom('novel_import_jobs')
      .select('status')
      .where('id', '=', jobId)
      .executeTakeFirst();
    if (!exists) throw new AppError('IMPORT_NOT_FOUND', 'Import job not found', 404);
    throw new AppError('IMPORT_NOT_READY', `Import job is ${exists.status}, not ready`, 409);
  }
  const preview = asPreview(job.preview);
  const chapterStatus = input.chapter_status ?? 'published';
  try {
    await db.transaction().execute(async (trx) => {
      const ids: string[] = [];
      for (const parsed of preview.novels) {
        const override = input.novels?.find((entry) => entry.index === parsed.index);
        if (override?.skip) continue;
        const chapters = await trx
          .selectFrom('novel_import_chapters')
          .select(['chapter_no', 'title', 'content', 'word_count'])
          .where('job_id', '=', jobId)
          .where('novel_index', '=', parsed.index)
          .orderBy('chapter_no')
          .execute();

        let novelId: string;
        if (job.mode === 'new') {
          novelId = await createNovelInTransaction(
            trx,
            {
              title: override?.title ?? parsed.title,
              author: override?.author !== undefined ? override.author : parsed.author,
              description:
                override?.description !== undefined ? override.description : parsed.description,
              language: override?.language ?? parsed.language ?? 'vi',
              tags: override?.tags ?? parsed.tags,
              status: override?.status ?? 'draft',
              ...(override?.category_ids ? { category_ids: override.category_ids } : {}),
              ...(parsed.cover_key && parsed.cover_url ? { cover_url: parsed.cover_url } : {}),
            },
            actor,
          );
          if (parsed.cover_key) {
            await trx
              .updateTable('novels')
              .set({ cover_key: parsed.cover_key })
              .where('id', '=', novelId)
              .execute();
          }
          await insertChapters(trx, novelId, chapters, 1, chapterStatus);
        } else {
          if (!job.target_novel_id) {
            throw new AppError('NOVEL_NOT_FOUND', 'Import job has no target novel', 400);
          }
          novelId = job.target_novel_id;
          const target = await trx
            .selectFrom('novels')
            .select('id')
            .where('id', '=', novelId)
            .forUpdate()
            .executeTakeFirst();
          if (!target) throw new AppError('NOVEL_NOT_FOUND', 'Target novel no longer exists', 404);
          if (job.mode === 'append') {
            const last = await trx
              .selectFrom('novel_chapters')
              .select((eb) => eb.fn.max('chapter_no').as('max'))
              .where('novel_id', '=', novelId)
              .executeTakeFirstOrThrow();
            await insertChapters(
              trx,
              novelId,
              chapters,
              ((last.max as number | null) ?? 0) + 1,
              chapterStatus,
            );
          } else {
            await replaceChapters(trx, novelId, chapters, chapterStatus, actor);
          }
        }
        await refreshNovelCounters(trx, novelId);
        ids.push(novelId);
      }
      await trx
        .updateTable('novel_import_jobs')
        .set({ status: 'done', result_novel_ids: ids, finished_at: new Date() })
        .where('id', '=', jobId)
        .execute();
      // Staged text is now in novel_chapters; keeping a second copy only costs space.
      await trx.deleteFrom('novel_import_chapters').where('job_id', '=', jobId).execute();
      await insertAudit(
        trx,
        actor,
        'NOVEL_IMPORT_COMMITTED',
        'novel_import_job',
        jobId,
        { novel_ids: ids, mode: job.mode },
        ip,
      );
    });
  } catch (err) {
    await db
      .updateTable('novel_import_jobs')
      .set({ status: 'ready' })
      .where('id', '=', jobId)
      .execute();
    throw err;
  }
  const committed = await getImportJob(jobId);
  await draftCoversForImport(committed.result_novel_ids);
  return committed;
}

export async function cancelImportJob(
  jobId: string,
  actor: NovelActor,
  ip: string,
): Promise<ImportJob> {
  await db.transaction().execute(async (trx) => {
    const job = await trx
      .updateTable('novel_import_jobs')
      .set({ status: 'cancelled', finished_at: new Date() })
      .where('id', '=', jobId)
      .where('status', 'in', ['queued', 'ready', 'failed'])
      .returning(['id'])
      .executeTakeFirst();
    if (!job)
      throw new AppError('IMPORT_NOT_CANCELLABLE', 'Import job cannot be cancelled now', 409);
    await trx.deleteFrom('novel_import_chapters').where('job_id', '=', jobId).execute();
    await insertAudit(trx, actor, 'NOVEL_IMPORT_CANCELLED', 'novel_import_job', jobId, {}, ip);
  });
  return getImportJob(jobId);
}
