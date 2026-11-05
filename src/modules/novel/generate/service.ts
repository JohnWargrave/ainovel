import { sql, type Selectable, type Updateable } from 'kysely';
import type pino from 'pino';
import { uuidv7 } from 'uuidv7';
import { db } from '../../../db/index.js';
import type { DB, NovelGenTask } from '../../../db/types.js';
import { AppError } from '../../../lib/errors.js';
import { getNovelGenQueue } from '../../../jobs/novel-generate.js';
import { isAbortError, type ChatUsage } from '../ai/deepseek-chat.js';
import { aiConfig, assertKnownModel, costUsd, loadAiSettings } from '../ai/settings.js';
import {
  createNovelInTransaction,
  insertAudit,
  refreshNovelCounters,
  type NovelActor,
} from '../admin.service.js';
import { createCoverJob, isCoverAiConfigured } from '../cover-ai/service.js';
import { countWords, normalizeContent } from '../text.js';
import { getNovelGenLlm, type NovelGenLlm } from './llm.js';
import {
  cleanChapterText,
  parseJsonObject,
  sanitizeArcs,
  sanitizeBible,
  sanitizeOutline,
  sanitizeOutlineChapter,
  type GenInput,
  type OutlineChapter,
  type StoryArc,
  type StoryBible,
  type StoryOutline,
} from './plan.js';
import {
  PREVIOUS_TAIL_CHARS,
  arcsPrompt,
  biblePrompt,
  chapterPrompt,
  outlineBatchPrompt,
  outlineChapterPrompt,
  type Prompt,
} from './prompts.js';
import type {
  CreateGenProjectInput,
  GenerateOutlineInput,
  RegenerateInput,
  StartWritingInput,
} from './schemas.js';

type ProjectRow = Selectable<DB['novel_gen_projects']>;
type ProjectUpdate = Updateable<DB['novel_gen_projects']>;

// A task whose worker died stays `queued`/`running`. Running tasks touch updated_at every few
// seconds, so a row this quiet is dead and may be restarted.
const STALE_MINUTES = 20;
const HEARTBEAT_MS = 2500;
// Chapters outlined per LLM call: small enough for a reliable JSON answer, large enough that a
// 100-chapter novel is a handful of calls.
const OUTLINE_BATCH = 15;
const MIN_CHAPTER_CHARS = 200;

export interface GenWrittenChapter {
  chapter_no: number;
  id: string;
  status: string;
  word_count: number;
}

export interface GenProjectSummary {
  id: string;
  title: string;
  status: string;
  task: string;
  busy: boolean;
  novel_id: string | null;
  progress: string | null;
  planned_chapters: number;
  created_at: string;
  updated_at: string;
}

export interface GenProject extends GenProjectSummary {
  input: GenInput;
  bible: StoryBible | null;
  outline: StoryOutline | null;
  task_note: string | null;
  task_chapter_no: number | null;
  write_from: number | null;
  write_to: number | null;
  write_next: number | null;
  write_overwrite: boolean;
  live_chapter_no: number | null;
  live_text: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  // USD at the prices in the AI settings when each call was made.
  cost_usd: number;
  errors: string[];
  written: GenWrittenChapter[];
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isBusy(row: { status: string; updated_at: Date | string }): boolean {
  return (
    (row.status === 'queued' || row.status === 'running') &&
    Date.now() - new Date(row.updated_at).getTime() < STALE_MINUTES * 60_000
  );
}

function projectTitle(input: GenInput, bibleTitle: string | null | undefined): string {
  return [bibleTitle, input.title].find((title) => title) ?? input.idea.slice(0, 80);
}

// A blank note means no note.
function noteOf(body: { note?: string }): string | null {
  const note = body.note?.trim();
  return note === undefined || note === '' ? null : note;
}

function readInput(value: unknown): GenInput {
  return value as GenInput;
}

async function loadRow(id: string): Promise<ProjectRow> {
  const row = await db
    .selectFrom('novel_gen_projects')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw new AppError('NOVEL_GEN_NOT_FOUND', 'Generation project not found', 404);
  return row;
}

function assertIdle(row: ProjectRow): void {
  if (isBusy(row)) {
    throw new AppError('NOVEL_GEN_BUSY', 'The AI is still working on this project', 409);
  }
}

export async function getGenProject(id: string): Promise<GenProject> {
  const row = await loadRow(id);
  const input = readInput(row.input);
  const bible = row.bible ? sanitizeBible(row.bible) : null;
  const outline = row.outline ? sanitizeOutline(row.outline) : null;
  const written = row.novel_id
    ? await db
        .selectFrom('novel_chapters')
        .select(['chapter_no', 'id', 'status', 'word_count'])
        .where('novel_id', '=', row.novel_id)
        .orderBy('chapter_no')
        .execute()
    : [];
  return {
    id: row.id,
    title: projectTitle(input, bible?.title),
    status: row.status,
    task: row.task,
    busy: isBusy(row),
    novel_id: row.novel_id,
    progress: row.progress,
    planned_chapters: outline?.chapters.length ?? 0,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    input,
    bible,
    outline,
    task_note: row.task_note,
    task_chapter_no: row.task_chapter_no,
    write_from: row.write_from,
    write_to: row.write_to,
    write_next: row.write_next,
    write_overwrite: row.write_overwrite,
    live_chapter_no: row.live_chapter_no,
    live_text: row.live_text,
    model: row.model,
    cost_usd: Number(row.cost_usd),
    prompt_tokens: Number(row.prompt_tokens),
    completion_tokens: Number(row.completion_tokens),
    errors: Array.isArray(row.errors) ? (row.errors as unknown[]).map(String) : [],
    written: written.map((chapter) => ({
      chapter_no: chapter.chapter_no,
      id: chapter.id,
      status: chapter.status,
      word_count: chapter.word_count,
    })),
  };
}

export async function listGenProjects(): Promise<{ items: GenProjectSummary[] }> {
  const rows = await db
    .selectFrom('novel_gen_projects')
    .select([
      'id',
      'status',
      'task',
      'novel_id',
      'progress',
      'input',
      'created_at',
      'updated_at',
      sql<string | null>`bible->>'title'`.as('bible_title'),
      sql<number>`coalesce(jsonb_array_length(outline->'chapters'), 0)`.as('planned'),
    ])
    .orderBy('created_at', 'desc')
    .limit(100)
    .execute();
  return {
    items: rows.map((row) => ({
      id: row.id,
      title: projectTitle(readInput(row.input), row.bible_title),
      status: row.status,
      task: row.task,
      busy: isBusy(row),
      novel_id: row.novel_id,
      progress: row.progress,
      planned_chapters: row.planned,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Starting tasks (API process)
// ---------------------------------------------------------------------------------------------

// Settings first: a key saved in the CMS (by another process) counts.
async function ready(): Promise<void> {
  await loadAiSettings();
  getNovelGenLlm();
}

// Claims the project for a new task in one statement, so two clicks can't both start one.
async function startTask(
  id: string,
  task: NovelGenTask,
  patch: ProjectUpdate,
): Promise<GenProject> {
  const runId = uuidv7();
  const claimed = await db
    .updateTable('novel_gen_projects')
    .set({
      ...patch,
      status: 'queued',
      task,
      run_id: runId,
      progress: 'Waiting for the AI worker',
      live_text: null,
      live_chapter_no: null,
      errors: JSON.stringify([]),
      updated_at: new Date(),
    })
    .where('id', '=', id)
    .where(
      sql<boolean>`NOT (status IN ('queued','running') AND updated_at > now() - make_interval(mins => ${STALE_MINUTES}))`,
    )
    .returning('id')
    .executeTakeFirst();
  if (!claimed) {
    await loadRow(id);
    throw new AppError('NOVEL_GEN_BUSY', 'The AI is still working on this project', 409);
  }
  await getNovelGenQueue().add(
    task,
    { projectId: id, runId },
    { attempts: 1, removeOnComplete: 1000 },
  );
  return getGenProject(id);
}

export async function createGenProject(
  body: CreateGenProjectInput,
  actor: NovelActor,
): Promise<GenProject> {
  // Fail in the request, not in the worker after the admin has started waiting.
  await loadAiSettings();
  getNovelGenLlm();
  const config = aiConfig();
  const model = body.model ?? config.novelModel;
  assertKnownModel(config, model);
  const categoryIds = [...new Set(body.category_ids ?? [])];
  const categories =
    categoryIds.length > 0
      ? await db
          .selectFrom('novel_categories')
          .select(['id', 'name'])
          .where('id', 'in', categoryIds)
          .execute()
      : [];
  if (categories.length !== categoryIds.length) {
    throw new AppError('CATEGORY_NOT_FOUND', 'One or more categories do not exist', 400);
  }
  const input: GenInput = {
    idea: body.idea.trim(),
    title: body.title?.trim() ?? '',
    category_ids: categoryIds,
    genres: categoryIds.map(
      (categoryId) => categories.find((c) => c.id === categoryId)?.name ?? '',
    ),
    language: body.language ?? 'vi',
    tone: body.tone?.trim() ?? '',
    audience: body.audience?.trim() ?? '',
    chapter_count: body.chapter_count ?? 30,
    words_per_chapter: body.words_per_chapter ?? 2000,
    auto_cover: body.auto_cover ?? true,
  };
  const id = uuidv7();
  const runId = uuidv7();
  await db
    .insertInto('novel_gen_projects')
    .values({
      id,
      task: 'bible',
      run_id: runId,
      input: JSON.stringify(input),
      model,
      progress: 'Waiting for the AI worker',
      admin_user_id: actor.id,
    })
    .execute();
  await getNovelGenQueue().add(
    'bible',
    { projectId: id, runId },
    { attempts: 1, removeOnComplete: 1000 },
  );
  return getGenProject(id);
}

export async function regenerateBible(id: string, body: RegenerateInput): Promise<GenProject> {
  await ready();
  return startTask(id, 'bible', { task_note: noteOf(body), task_chapter_no: null });
}

export async function generateOutline(id: string, body: GenerateOutlineInput): Promise<GenProject> {
  await ready();
  const row = await loadRow(id);
  assertIdle(row);
  if (!row.bible) {
    throw new AppError('NOVEL_GEN_NO_BIBLE', 'Write the story bible before the outline', 409);
  }
  const input = readInput(row.input);
  return startTask(id, 'outline', {
    task_note: noteOf(body),
    task_chapter_no: null,
    ...(body.chapter_count !== undefined
      ? { input: JSON.stringify({ ...input, chapter_count: body.chapter_count }) }
      : {}),
  });
}

export async function regenerateOutlineChapter(
  id: string,
  no: number,
  body: RegenerateInput,
): Promise<GenProject> {
  await ready();
  const row = await loadRow(id);
  assertIdle(row);
  const chapter = (row.outline ? sanitizeOutline(row.outline) : null)?.chapters.find(
    (entry) => entry.no === no,
  );
  if (!chapter)
    throw new AppError('NOVEL_GEN_CHAPTER_NOT_FOUND', 'No such chapter in the outline', 404);
  if (chapter.locked) {
    throw new AppError(
      'NOVEL_GEN_CHAPTER_LOCKED',
      'Unlock the chapter before regenerating it',
      409,
    );
  }
  return startTask(id, 'outline_chapter', { task_note: noteOf(body), task_chapter_no: no });
}

export async function updateBible(id: string, value: unknown): Promise<GenProject> {
  const row = await loadRow(id);
  assertIdle(row);
  const bible = sanitizeBible(value);
  if (!bible) throw new AppError('NOVEL_GEN_INVALID_BIBLE', 'The story bible needs a title', 400);
  await db
    .updateTable('novel_gen_projects')
    .set({ bible: JSON.stringify(bible), updated_at: new Date() })
    .where('id', '=', id)
    .execute();
  return getGenProject(id);
}

export async function updateOutline(id: string, value: unknown): Promise<GenProject> {
  const row = await loadRow(id);
  assertIdle(row);
  const outline = sanitizeOutline(value);
  if (!outline) {
    throw new AppError('NOVEL_GEN_INVALID_OUTLINE', 'The outline needs at least one chapter', 400);
  }
  const input = readInput(row.input);
  await db
    .updateTable('novel_gen_projects')
    .set({
      outline: JSON.stringify(outline),
      // The edited outline is now the planned length; regenerating keeps it.
      input: JSON.stringify({ ...input, chapter_count: outline.chapters.length }),
      updated_at: new Date(),
    })
    .where('id', '=', id)
    .execute();
  return getGenProject(id);
}

export async function startWriting(
  id: string,
  body: StartWritingInput,
  actor: NovelActor,
  ip: string,
  logger?: { warn(details: object, message: string): void },
): Promise<GenProject> {
  await ready();
  const row = await loadRow(id);
  assertIdle(row);
  const bible = row.bible ? sanitizeBible(row.bible) : null;
  if (!bible) throw new AppError('NOVEL_GEN_NO_BIBLE', 'Write the story bible first', 409);
  const outline = row.outline ? sanitizeOutline(row.outline) : null;
  if (!outline) throw new AppError('NOVEL_GEN_NO_OUTLINE', 'Write the outline first', 409);
  const input: GenInput = {
    ...readInput(row.input),
    ...(body.words_per_chapter !== undefined ? { words_per_chapter: body.words_per_chapter } : {}),
  };
  const overwrite = body.overwrite ?? false;
  const last = outline.chapters.length;
  if (body.model !== undefined) assertKnownModel(aiConfig(), body.model);

  // The novel is created on the first run, from the bible as it stands then.
  // An object, not a `let`: TypeScript can't see the transaction callback assign it.
  const novelState = { created: false };
  const novelId = await db.transaction().execute(async (trx) => {
    const locked = await trx
      .selectFrom('novel_gen_projects')
      .select('novel_id')
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (locked.novel_id) return locked.novel_id;
    const newId = await createNovelInTransaction(
      trx,
      {
        title: bible.title,
        description: bible.description || null,
        tags: bible.tags.map((tag) => tag.slice(0, 60)),
        category_ids: input.category_ids,
        language: input.language,
        status: 'draft',
        ai_generated: true,
        editor_reviewed: false,
      },
      actor,
    );
    await insertAudit(
      trx,
      actor,
      'NOVEL_CREATED',
      'novel',
      newId,
      { title: bible.title, source: 'ai_generate', project_id: id },
      ip,
    );
    await trx
      .updateTable('novel_gen_projects')
      .set({ novel_id: newId })
      .where('id', '=', id)
      .execute();
    novelState.created = true;
    return newId;
  });

  const writtenNos = new Set(
    (
      await db
        .selectFrom('novel_chapters')
        .select('chapter_no')
        .where('novel_id', '=', novelId)
        .execute()
    ).map((chapter) => chapter.chapter_no),
  );
  const firstMissing = outline.chapters.find((chapter) => !writtenNos.has(chapter.no))?.no;
  const from = body.from ?? (overwrite ? 1 : firstMissing);
  if (from === undefined) {
    throw new AppError(
      'NOVEL_GEN_NOTHING_TO_WRITE',
      'Every chapter in the outline is already written; tick "overwrite" to rewrite them',
      409,
    );
  }
  const to = Math.min(body.to ?? last, last);
  if (from > to) {
    throw new AppError(
      'NOVEL_GEN_INVALID_RANGE',
      `Pick chapters between 1 and ${String(last)}`,
      400,
    );
  }

  const project = await startTask(id, 'chapters', {
    input: JSON.stringify(input),
    novel_id: novelId,
    task_note: null,
    task_chapter_no: null,
    write_from: from,
    write_to: to,
    write_next: from,
    write_overwrite: overwrite,
    ...(body.model !== undefined ? { model: body.model } : {}),
  });
  if (novelState.created && input.auto_cover && isCoverAiConfigured()) {
    // A cover is a nice-to-have: never fail the writing run over it.
    await createCoverJob(novelId, actor, 'generate').catch((err: unknown) => {
      logger?.warn({ err, novelId }, 'could not queue the cover for a generated novel');
    });
  }
  return project;
}

// A chapter run pauses (and resumes from where it stopped); planning tasks just stop. An in-flight
// LLM call notices on its next heartbeat and drops its result.
export async function stopProject(id: string): Promise<GenProject> {
  await db
    .updateTable('novel_gen_projects')
    .set({
      status: sql`CASE WHEN task = 'chapters' THEN 'paused' ELSE 'idle' END`,
      progress: null,
      live_text: null,
      live_chapter_no: null,
      updated_at: new Date(),
    })
    .where('id', '=', id)
    .where('status', 'in', ['queued', 'running'])
    .execute();
  return getGenProject(id);
}

// The novel and its chapters stay; only the plan goes.
export async function deleteGenProject(id: string): Promise<{ deleted: boolean }> {
  const row = await loadRow(id);
  assertIdle(row);
  await db.deleteFrom('novel_gen_projects').where('id', '=', id).execute();
  return { deleted: true };
}

// ---------------------------------------------------------------------------------------------
// Running tasks (worker)
// ---------------------------------------------------------------------------------------------

// Writes progress for the CMS every few seconds and, in the same statement, checks the run is still
// the current one. When it isn't (stopped, or replaced by a newer task) it aborts the LLM call.
class RunGuard {
  private readonly controller = new AbortController();
  private pending: ProjectUpdate = {};
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly projectId: string,
    private readonly runId: string,
    private readonly logger?: pino.Logger,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, HEARTBEAT_MS);
  }

  // Waits for a heartbeat already sent, so it can't land after the task's final update.
  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.inflight;
  }

  set(fields: ProjectUpdate): void {
    this.pending = { ...this.pending, ...fields };
  }

  flush(): Promise<void> {
    if (this.inflight || this.aborted) return this.inflight ?? Promise.resolve();
    this.inflight = this.write().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async write(): Promise<void> {
    const fields = this.pending;
    this.pending = {};
    try {
      const current = await db
        .updateTable('novel_gen_projects')
        .set({ ...fields, updated_at: new Date() })
        .where('id', '=', this.projectId)
        .where('run_id', '=', this.runId)
        .where('status', '=', 'running')
        .returning('id')
        .executeTakeFirst();
      if (!current) this.controller.abort();
    } catch (err) {
      this.logger?.warn({ err, projectId: this.projectId }, 'novel-gen heartbeat failed');
    }
  }

  assertCurrent(): void {
    if (this.aborted) throw new AppError('NOVEL_GEN_ABORTED', 'Stopped', 499);
  }
}

interface RunContext {
  row: ProjectRow;
  llm: NovelGenLlm;
  // The project's model, priced from the AI settings.
  model: string;
  guard: RunGuard;
  warnings: string[];
}

// Spend is recorded whatever happens to the run: the call was paid for either way.
async function addUsage(ctx: RunContext, usage: ChatUsage | null): Promise<void> {
  if (!usage) return;
  const cost = costUsd(aiConfig(), ctx.model, usage);
  await db
    .updateTable('novel_gen_projects')
    .set({
      prompt_tokens: sql`prompt_tokens + ${usage.prompt_tokens}`,
      completion_tokens: sql`completion_tokens + ${usage.completion_tokens}`,
      cost_usd: sql`cost_usd + ${cost.toFixed(6)}::numeric`,
    })
    .where('id', '=', ctx.row.id)
    .execute();
}

// Saves only while the run is still current: a stopped or replaced run must not overwrite the plan.
async function saveForRun(ctx: RunContext, fields: ProjectUpdate): Promise<void> {
  const saved = await db
    .updateTable('novel_gen_projects')
    .set({ ...fields, updated_at: new Date() })
    .where('id', '=', ctx.row.id)
    .where('run_id', '=', ctx.row.run_id)
    .where('status', '=', 'running')
    .returning('id')
    .executeTakeFirst();
  if (!saved) throw new AppError('NOVEL_GEN_ABORTED', 'Stopped', 499);
}

function refused(): AppError {
  return new AppError(
    'NOVEL_GEN_REFUSED',
    'DeepSeek declined to write this; soften the idea or the instructions and try again',
    422,
  );
}

// JSON mode occasionally answers with empty or cut-off content; one retry covers it.
async function planJson<T>(
  ctx: RunContext,
  prompt: Prompt,
  maxTokens: number,
  parse: (value: Record<string, unknown>) => T | null,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    ctx.guard.assertCurrent();
    const result = await ctx.llm.complete({
      model: ctx.model,
      kind: 'plan',
      ...prompt,
      maxTokens,
      signal: ctx.guard.signal,
    });
    await addUsage(ctx, result.usage);
    if (result.finishReason === 'content_filter') throw refused();
    const value = parseJsonObject(result.content);
    const parsed = value ? parse(value) : null;
    if (parsed !== null) return parsed;
  }
  throw new AppError(
    'NOVEL_GEN_BAD_OUTPUT',
    'The AI returned an unusable answer twice; try again',
    502,
  );
}

function requireBible(row: ProjectRow): StoryBible {
  const bible = row.bible ? sanitizeBible(row.bible) : null;
  if (!bible) throw new AppError('NOVEL_GEN_NO_BIBLE', 'The story bible is missing', 409);
  return bible;
}

function requireOutline(row: ProjectRow): StoryOutline {
  const outline = row.outline ? sanitizeOutline(row.outline) : null;
  if (!outline) throw new AppError('NOVEL_GEN_NO_OUTLINE', 'The outline is missing', 409);
  return outline;
}

async function runBible(ctx: RunContext): Promise<void> {
  const input = readInput(ctx.row.input);
  ctx.guard.set({ progress: 'Writing the story bible' });
  const previous = ctx.row.bible ? sanitizeBible(ctx.row.bible) : null;
  const bible = await planJson(
    ctx,
    biblePrompt(input, previous, ctx.row.task_note),
    4000,
    (value) => sanitizeBible(value),
  );
  if (input.title) bible.title = input.title;
  await saveForRun(ctx, { bible: JSON.stringify(bible) });
}

function parseBatch(
  value: Record<string, unknown>,
  from: number,
  to: number,
): Map<number, OutlineChapter> | null {
  const entries = Array.isArray(value['chapters']) ? value['chapters'] : [];
  const chapters = new Map<number, OutlineChapter>();
  entries.forEach((entry, index) => {
    const raw = entry as Record<string, unknown> | null;
    const claimed = typeof raw?.['no'] === 'number' ? raw['no'] : from + index;
    const no = claimed >= from && claimed <= to && !chapters.has(claimed) ? claimed : from + index;
    const chapter = sanitizeOutlineChapter(entry, no);
    if (chapter && no <= to) chapters.set(no, { ...chapter, locked: false });
  });
  return chapters.size > 0 ? chapters : null;
}

async function runOutline(ctx: RunContext): Promise<void> {
  const input = readInput(ctx.row.input);
  const bible = requireBible(ctx.row);
  const total = input.chapter_count;
  const lockedByNo = new Map(
    ((ctx.row.outline ? sanitizeOutline(ctx.row.outline) : null)?.chapters ?? [])
      .filter((chapter) => chapter.locked && chapter.no <= total)
      .map((chapter) => [chapter.no, chapter]),
  );

  ctx.guard.set({ progress: 'Planning the story arcs' });
  const arcs: StoryArc[] = await planJson(
    ctx,
    arcsPrompt(input, bible, ctx.row.task_note),
    4000,
    (value) => {
      const parsed = sanitizeArcs(value['arcs'], total);
      return parsed.length > 0 ? parsed : null;
    },
  );

  const chapters: OutlineChapter[] = [];
  for (let from = 1; from <= total; from += OUTLINE_BATCH) {
    const to = Math.min(total, from + OUTLINE_BATCH - 1);
    const locked: OutlineChapter[] = [];
    for (let no = from; no <= to; no += 1) {
      const chapter = lockedByNo.get(no);
      if (chapter) locked.push(chapter);
    }
    if (locked.length === to - from + 1) {
      chapters.push(...locked);
      continue;
    }
    ctx.guard.set({
      progress: `Outlining chapters ${String(from)}–${String(to)} of ${String(total)}`,
    });
    const batch = await planJson(
      ctx,
      outlineBatchPrompt({
        input,
        bible,
        arcs,
        previous: chapters,
        locked,
        from,
        to,
        note: ctx.row.task_note,
      }),
      6000,
      (value) => parseBatch(value, from, to),
    );
    for (let no = from; no <= to; no += 1) {
      const chapter = lockedByNo.get(no) ?? batch.get(no);
      if (chapter) {
        chapters.push(chapter);
      } else {
        ctx.warnings.push(`The AI skipped chapter ${String(no)}; regenerate it in the outline`);
        chapters.push({
          no,
          title: `#${String(no)}`,
          beats: ['(empty: regenerate this chapter)'],
          locked: false,
        });
      }
    }
  }
  await saveForRun(ctx, { outline: JSON.stringify({ arcs, chapters } satisfies StoryOutline) });
}

async function runOutlineChapter(ctx: RunContext): Promise<void> {
  const input = readInput(ctx.row.input);
  const bible = requireBible(ctx.row);
  const outline = requireOutline(ctx.row);
  const no = ctx.row.task_chapter_no ?? 0;
  const index = outline.chapters.findIndex((chapter) => chapter.no === no);
  if (index < 0)
    throw new AppError('NOVEL_GEN_CHAPTER_NOT_FOUND', 'No such chapter in the outline', 404);
  ctx.guard.set({ progress: `Re-outlining chapter ${String(no)}` });
  const chapter = await planJson(
    ctx,
    outlineChapterPrompt({ input, bible, outline, no, note: ctx.row.task_note }),
    2000,
    (value) => sanitizeOutlineChapter(value, no),
  );
  outline.chapters[index] = { ...chapter, locked: false };
  await saveForRun(ctx, { outline: JSON.stringify(outline) });
}

async function saveChapter(
  ctx: RunContext,
  novelId: string,
  no: number,
  title: string,
  text: string,
): Promise<void> {
  const content = normalizeContent(text);
  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('novel_gen_projects')
      .select('id')
      .where('id', '=', ctx.row.id)
      .where('run_id', '=', ctx.row.run_id)
      .where('status', '=', 'running')
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new AppError('NOVEL_GEN_ABORTED', 'Stopped', 499);
    const novel = await trx
      .selectFrom('novels')
      .select('id')
      .where('id', '=', novelId)
      .forUpdate()
      .executeTakeFirst();
    if (!novel) throw new AppError('NOVEL_NOT_FOUND', 'The novel was deleted', 404);
    const existing = await trx
      .selectFrom('novel_chapters')
      .select(['id', 'title', 'content'])
      .where('novel_id', '=', novelId)
      .where('chapter_no', '=', no)
      .forUpdate()
      .executeTakeFirst();
    let chapterId: string;
    if (existing) {
      // Overwrite keeps the old text as a revision, like an editor's save does.
      chapterId = existing.id;
      await trx
        .insertInto('novel_chapter_revisions')
        .values({
          id: uuidv7(),
          chapter_id: existing.id,
          title: existing.title,
          content: existing.content,
          edited_by: ctx.row.admin_user_id,
        })
        .execute();
      await trx
        .updateTable('novel_chapters')
        .set({ title, content, word_count: countWords(content), updated_at: new Date() })
        .where('id', '=', existing.id)
        .execute();
    } else {
      chapterId = uuidv7();
      await trx
        .insertInto('novel_chapters')
        .values({
          id: chapterId,
          novel_id: novelId,
          chapter_no: no,
          title,
          content,
          word_count: countWords(content),
          is_vip: null,
          unlock_coin_price: null,
          status: 'draft',
          publish_at: null,
        })
        .execute();
    }
    await refreshNovelCounters(trx, novelId);
    await trx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: ctx.row.admin_user_id,
        action: 'NOVEL_CHAPTER_AI_WRITTEN',
        target_type: 'novel_chapter',
        target_id: chapterId,
        detail: JSON.stringify({
          novel_id: novelId,
          chapter_no: no,
          project_id: ctx.row.id,
          overwrite: Boolean(existing),
        }),
        ip: null,
      })
      .execute();
    await trx
      .updateTable('novel_gen_projects')
      .set({ write_next: no + 1, live_text: null, live_chapter_no: null, updated_at: new Date() })
      .where('id', '=', ctx.row.id)
      .execute();
  });
}

// Writes one chapter. Returns whether the run has more to write (the caller queues the next job).
async function runChapter(ctx: RunContext): Promise<boolean> {
  const { row } = ctx;
  const input = readInput(row.input);
  const bible = requireBible(row);
  const outline = requireOutline(row);
  const novelId = row.novel_id;
  if (!novelId) throw new AppError('NOVEL_NOT_FOUND', 'The novel was deleted', 404);
  const to = row.write_to ?? outline.chapters.length;
  let no = row.write_next ?? row.write_from ?? 1;

  const existing = new Set(
    (
      await db
        .selectFrom('novel_chapters')
        .select('chapter_no')
        .where('novel_id', '=', novelId)
        .where('chapter_no', '>=', no)
        .where('chapter_no', '<=', to)
        .execute()
    ).map((chapter) => chapter.chapter_no),
  );
  const planned = new Map(outline.chapters.map((chapter) => [chapter.no, chapter]));
  while (no <= to && (!planned.has(no) || (existing.has(no) && !row.write_overwrite))) no += 1;
  if (no > to) {
    await saveForRun(ctx, { write_next: no });
    return false;
  }
  const chapter = planned.get(no);
  if (!chapter) return false;

  const previous = await db
    .selectFrom('novel_chapters')
    .select(sql<string>`right(content, ${PREVIOUS_TAIL_CHARS})`.as('tail'))
    .where('novel_id', '=', novelId)
    .where('chapter_no', '=', no - 1)
    .executeTakeFirst();
  const from = row.write_from ?? 1;
  ctx.guard.set({
    progress: `Writing chapter ${String(no)} (${String(no - from + 1)} of ${String(to - from + 1)})`,
    live_chapter_no: no,
    live_text: '',
  });
  ctx.guard.assertCurrent();
  const prompt = chapterPrompt({ input, bible, outline, no, previousTail: previous?.tail ?? '' });
  const result = await ctx.llm.complete({
    model: ctx.model,
    kind: 'chapter',
    ...prompt,
    // Vietnamese runs about 1.5–2 tokens a word; leave room so a chapter is not cut mid-scene.
    maxTokens: Math.min(16_000, input.words_per_chapter * 3 + 1000),
    onText: (text) => {
      ctx.guard.set({ live_text: text });
    },
    signal: ctx.guard.signal,
  });
  await addUsage(ctx, result.usage);
  if (result.finishReason === 'content_filter') throw refused();
  const text = cleanChapterText(result.content, chapter.title);
  if (text.length < MIN_CHAPTER_CHARS) {
    throw new AppError(
      'NOVEL_GEN_BAD_OUTPUT',
      `The AI returned almost nothing for chapter ${String(no)}`,
      502,
    );
  }
  if (result.finishReason === 'length') {
    ctx.warnings.push(`Chapter ${String(no)} hit the length limit and may stop mid-scene`);
  }
  await saveChapter(ctx, novelId, no, chapter.title, text);
  return no < to;
}

export async function processGenJob(
  projectId: string,
  runId: string,
  logger?: pino.Logger,
): Promise<void> {
  const row = await db
    .updateTable('novel_gen_projects')
    .set({ status: 'running', updated_at: new Date() })
    .where('id', '=', projectId)
    .where('run_id', '=', runId)
    .where('status', 'in', ['queued', 'running'])
    .returningAll()
    .executeTakeFirst();
  if (!row) return;

  const guard = new RunGuard(projectId, runId, logger);
  const warnings: string[] = [];
  guard.start();
  try {
    await loadAiSettings();
    const ctx: RunContext = {
      row,
      llm: getNovelGenLlm(),
      model: row.model ?? aiConfig().novelModel,
      guard,
      warnings,
    };
    let more = false;
    if (row.task === 'bible') await runBible(ctx);
    if (row.task === 'outline') await runOutline(ctx);
    if (row.task === 'outline_chapter') await runOutlineChapter(ctx);
    if (row.task === 'chapters') more = await runChapter(ctx);
    await guard.stop();
    await db
      .updateTable('novel_gen_projects')
      .set({
        // A writing run keeps `running` between chapters; the next job picks it up.
        status: more ? 'running' : 'idle',
        progress: more ? 'Starting the next chapter' : null,
        live_text: null,
        live_chapter_no: null,
        errors: sql`errors || ${JSON.stringify(warnings)}::jsonb`,
        updated_at: new Date(),
      })
      .where('id', '=', projectId)
      .where('run_id', '=', runId)
      .where('status', '=', 'running')
      .execute();
    if (more) {
      await getNovelGenQueue().add(
        'chapters',
        { projectId, runId },
        { attempts: 1, removeOnComplete: 1000 },
      );
    }
  } catch (err) {
    await guard.stop();
    if (guard.aborted || isAbortError(err)) return;
    logger?.error({ err, projectId, task: row.task }, 'novel generation failed');
    const message = err instanceof AppError ? err.message : 'Generation failed';
    await db
      .updateTable('novel_gen_projects')
      .set({
        status: 'failed',
        progress: null,
        live_text: null,
        live_chapter_no: null,
        errors: sql`errors || ${JSON.stringify([...warnings, message])}::jsonb`,
        updated_at: new Date(),
      })
      .where('id', '=', projectId)
      .where('run_id', '=', runId)
      .execute();
  }
}
