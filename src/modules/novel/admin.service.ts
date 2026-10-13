import { uuidv7 } from 'uuidv7';
import { sql, type Selectable, type Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB, NovelStatus } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { isChapterVip } from './access.js';
import { buildSearchText, countWords, foldForSearch, normalizeContent, slugify } from './text.js';
import type {
  AdminCategory,
  AdminChapter,
  AdminChapterListQuery,
  AdminChapterSummary,
  AdminNovel,
  AdminNovelListQuery,
  BulkChapterAction,
  BulkNovelAction,
  CategoryInput,
  CreateChapterInput,
  CreateNovelInput,
  UpdateChapterInput,
  UpdateNovelInput,
} from './admin-schemas.js';

export interface NovelActor {
  id: string;
  role: string;
}

type Trx = Transaction<DB>;

export async function insertAudit(
  trx: Trx,
  actor: NovelActor,
  action: string,
  targetType: string,
  targetId: string | null,
  detail: Record<string, unknown>,
  ip: string | null,
): Promise<void> {
  await trx
    .insertInto('audit_log')
    .values({
      id: uuidv7(),
      admin_user_id: actor.id,
      action,
      target_type: targetType,
      target_id: targetId,
      detail: JSON.stringify(detail),
      ip,
    })
    .execute();
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

// ---------------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------------

export async function listAdminCategories(): Promise<{ items: AdminCategory[] }> {
  const rows = await db
    .selectFrom('novel_categories')
    .leftJoin('novel_category_links', 'novel_category_links.category_id', 'novel_categories.id')
    .select([
      'novel_categories.id',
      'novel_categories.slug',
      'novel_categories.name',
      'novel_categories.sort_order',
      'novel_categories.is_active',
      (eb) => eb.fn.count<string>('novel_category_links.novel_id').as('novel_count'),
    ])
    .groupBy('novel_categories.id')
    .orderBy('novel_categories.sort_order')
    .orderBy('novel_categories.name')
    .execute();
  return { items: rows.map((row) => ({ ...row, novel_count: Number(row.novel_count) })) };
}

async function uniqueCategorySlug(trx: Trx, base: string, excludeId?: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${String(attempt + 1)}`;
    let query = trx.selectFrom('novel_categories').select('id').where('slug', '=', candidate);
    if (excludeId) query = query.where('id', '!=', excludeId);
    if (!(await query.executeTakeFirst())) return candidate;
  }
  throw new AppError('SLUG_TAKEN', 'Could not find a free slug', 409);
}

export async function createCategory(
  input: CategoryInput,
  actor: NovelActor,
  ip: string,
): Promise<AdminCategory> {
  return db.transaction().execute(async (trx) => {
    const id = uuidv7();
    const slug = input.slug ?? (await uniqueCategorySlug(trx, slugify(input.name)));
    const taken = await trx
      .selectFrom('novel_categories')
      .select('id')
      .where('slug', '=', slug)
      .executeTakeFirst();
    if (taken) throw new AppError('SLUG_TAKEN', 'Slug is already used by another category', 409);
    await trx
      .insertInto('novel_categories')
      .values({
        id,
        slug,
        name: input.name,
        sort_order: input.sort_order ?? 0,
        is_active: input.is_active ?? true,
      })
      .execute();
    await insertAudit(trx, actor, 'NOVEL_CATEGORY_CREATED', 'novel_category', id, { input }, ip);
    return {
      id,
      slug,
      name: input.name,
      sort_order: input.sort_order ?? 0,
      is_active: input.is_active ?? true,
      novel_count: 0,
    };
  });
}

export async function updateCategory(
  id: string,
  input: CategoryInput,
  actor: NovelActor,
  ip: string,
): Promise<AdminCategory> {
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('novel_categories')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError('CATEGORY_NOT_FOUND', 'Category not found', 404);
    if (input.slug && input.slug !== before.slug) {
      const taken = await trx
        .selectFrom('novel_categories')
        .select('id')
        .where('slug', '=', input.slug)
        .where('id', '!=', id)
        .executeTakeFirst();
      if (taken) throw new AppError('SLUG_TAKEN', 'Slug is already used by another category', 409);
    }
    await trx
      .updateTable('novel_categories')
      .set({
        name: input.name,
        ...(input.slug ? { slug: input.slug } : {}),
        ...(input.sort_order !== undefined ? { sort_order: input.sort_order } : {}),
        ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    await insertAudit(
      trx,
      actor,
      'NOVEL_CATEGORY_UPDATED',
      'novel_category',
      id,
      { before, input },
      ip,
    );
  });
  const { items } = await listAdminCategories();
  const updated = items.find((item) => item.id === id);
  if (!updated) throw new AppError('CATEGORY_NOT_FOUND', 'Category not found', 404);
  return updated;
}

export async function deleteCategory(
  id: string,
  actor: NovelActor,
  ip: string,
): Promise<{ deleted: boolean }> {
  return db.transaction().execute(async (trx) => {
    const deleted = await trx
      .deleteFrom('novel_categories')
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!deleted) throw new AppError('CATEGORY_NOT_FOUND', 'Category not found', 404);
    await insertAudit(trx, actor, 'NOVEL_CATEGORY_DELETED', 'novel_category', id, { deleted }, ip);
    return { deleted: true };
  });
}

// ---------------------------------------------------------------------------------------------
// Novels
// ---------------------------------------------------------------------------------------------

type NovelRow = Awaited<ReturnType<typeof selectNovel>>;

function selectNovel(
  executor: Trx | typeof db,
  id: string,
): Promise<Selectable<DB['novels']> | undefined> {
  return executor.selectFrom('novels').selectAll().where('id', '=', id).executeTakeFirst();
}

async function serializeNovels(rows: readonly NonNullable<NovelRow>[]): Promise<AdminNovel[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [links, totals] = await Promise.all([
    db
      .selectFrom('novel_category_links')
      .select(['novel_id', 'category_id'])
      .where('novel_id', 'in', ids)
      .execute(),
    db
      .selectFrom('novel_chapters')
      .select(['novel_id', (eb) => eb.fn.countAll<string>().as('total')])
      .where('novel_id', 'in', ids)
      .groupBy('novel_id')
      .execute(),
  ]);
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    alt_titles: row.alt_titles,
    author: row.author,
    translator: row.translator,
    description: row.description,
    cover_url: row.cover_url,
    status: row.status,
    completion_status: row.completion_status,
    language: row.language,
    tags: row.tags,
    regions: row.regions,
    is_featured: row.is_featured,
    featured_rank: row.featured_rank,
    vip_from_chapter: row.vip_from_chapter,
    default_unlock_coin: row.default_unlock_coin,
    allow_ad_unlock: row.allow_ad_unlock,
    chapter_count: row.chapter_count,
    total_chapter_count: Number(totals.find((total) => total.novel_id === row.id)?.total ?? 0),
    word_count: Number(row.word_count),
    category_ids: links.filter((link) => link.novel_id === row.id).map((link) => link.category_id),
    published_at: iso(row.published_at),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  }));
}

export async function listAdminNovels(
  query: AdminNovelListQuery,
): Promise<{ items: AdminNovel[]; next_cursor: string | null; total: number }> {
  const limit = query.limit ?? 50;
  const offset = Number(query.cursor ?? 0);
  let builder = db.selectFrom('novels');
  if (query.q) {
    builder = builder.where('search_text', 'ilike', `%${escapeLike(foldForSearch(query.q))}%`);
  }
  if (query.status) builder = builder.where('status', '=', query.status);
  if (query.completion_status) {
    builder = builder.where('completion_status', '=', query.completion_status);
  }
  if (query.language) builder = builder.where('language', '=', query.language);
  if (query.featured !== undefined) builder = builder.where('is_featured', '=', query.featured);
  if (query.category_id) {
    const categoryId = query.category_id;
    builder = builder.where((eb) =>
      eb.exists(
        eb
          .selectFrom('novel_category_links')
          .select('novel_id')
          .whereRef('novel_category_links.novel_id', '=', 'novels.id')
          .where('novel_category_links.category_id', '=', categoryId),
      ),
    );
  }
  const totalRow = await builder
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  let ordered = builder.selectAll();
  switch (query.sort ?? 'updated') {
    case 'created':
      ordered = ordered.orderBy('created_at', 'desc');
      break;
    case 'title':
      ordered = ordered.orderBy('title', 'asc');
      break;
    default:
      ordered = ordered.orderBy('updated_at', 'desc');
  }
  const rows = await ordered
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .offset(offset)
    .execute();
  return {
    items: await serializeNovels(rows.slice(0, limit)),
    next_cursor: rows.length > limit ? String(offset + limit) : null,
    total: Number(totalRow.total),
  };
}

export async function getAdminNovel(id: string): Promise<AdminNovel> {
  const row = await selectNovel(db, id);
  if (!row) throw new AppError('NOVEL_NOT_FOUND', 'Novel not found', 404);
  const [novel] = await serializeNovels([row]);
  if (!novel) throw new AppError('NOVEL_NOT_FOUND', 'Novel not found', 404);
  return novel;
}

export async function uniqueNovelSlug(trx: Trx, base: string, excludeId?: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${String(attempt + 1)}`;
    let query = trx.selectFrom('novels').select('id').where('slug', '=', candidate);
    if (excludeId) query = query.where('id', '!=', excludeId);
    if (!(await query.executeTakeFirst())) return candidate;
  }
  throw new AppError('SLUG_TAKEN', 'Could not find a free slug', 409);
}

async function setCategories(
  trx: Trx,
  novelId: string,
  categoryIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(categoryIds)];
  if (unique.length > 0) {
    const found = await trx
      .selectFrom('novel_categories')
      .select('id')
      .where('id', 'in', unique)
      .execute();
    if (found.length !== unique.length) {
      throw new AppError('CATEGORY_NOT_FOUND', 'One or more categories do not exist', 400);
    }
  }
  await trx.deleteFrom('novel_category_links').where('novel_id', '=', novelId).execute();
  if (unique.length > 0) {
    await trx
      .insertInto('novel_category_links')
      .values(unique.map((categoryId) => ({ novel_id: novelId, category_id: categoryId })))
      .execute();
  }
}

// chapter_count/word_count describe what readers can see: published chapters only.
export async function refreshNovelCounters(trx: Trx, novelId: string): Promise<void> {
  await trx
    .updateTable('novels')
    .set({
      chapter_count: sql<number>`(SELECT count(*) FROM novel_chapters WHERE novel_id = ${novelId} AND status = 'published')`,
      word_count: sql<string>`(SELECT coalesce(sum(word_count), 0) FROM novel_chapters WHERE novel_id = ${novelId} AND status = 'published')`,
      updated_at: new Date(),
    })
    .where('id', '=', novelId)
    .execute();
}

export async function createNovelInTransaction(
  trx: Trx,
  input: CreateNovelInput,
  actor: NovelActor | null,
): Promise<string> {
  const id = uuidv7();
  const slug = input.slug ?? (await uniqueNovelSlug(trx, slugify(input.title)));
  if (input.slug) {
    const taken = await trx
      .selectFrom('novels')
      .select('id')
      .where('slug', '=', slug)
      .executeTakeFirst();
    if (taken) throw new AppError('SLUG_TAKEN', 'Slug is already used by another novel', 409);
  }
  const status = input.status ?? 'draft';
  await trx
    .insertInto('novels')
    .values({
      id,
      slug,
      title: input.title,
      alt_titles: input.alt_titles ?? [],
      author: input.author ?? null,
      translator: input.translator ?? null,
      description: input.description ?? null,
      cover_url: input.cover_url ?? null,
      status,
      completion_status: input.completion_status ?? 'ongoing',
      language: input.language ?? 'vi',
      tags: input.tags ?? [],
      regions: input.regions ?? null,
      is_featured: input.is_featured ?? false,
      featured_rank: input.featured_rank ?? 0,
      vip_from_chapter: input.vip_from_chapter ?? null,
      default_unlock_coin: input.default_unlock_coin ?? 0,
      allow_ad_unlock: input.allow_ad_unlock ?? true,
      search_text: buildSearchText(input),
      published_at: status === 'published' ? new Date() : null,
      created_by: actor?.id ?? null,
    })
    .execute();
  if (input.category_ids) await setCategories(trx, id, input.category_ids);
  return id;
}

export async function createNovel(
  input: CreateNovelInput,
  actor: NovelActor,
  ip: string,
): Promise<AdminNovel> {
  const id = await db.transaction().execute(async (trx) => {
    const novelId = await createNovelInTransaction(trx, input, actor);
    await insertAudit(trx, actor, 'NOVEL_CREATED', 'novel', novelId, { title: input.title }, ip);
    return novelId;
  });
  return getAdminNovel(id);
}

export async function updateNovel(
  id: string,
  input: UpdateNovelInput,
  actor: NovelActor,
  ip: string,
): Promise<AdminNovel> {
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('novels')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError('NOVEL_NOT_FOUND', 'Novel not found', 404);
    if (input.slug && input.slug !== before.slug) {
      const taken = await trx
        .selectFrom('novels')
        .select('id')
        .where('slug', '=', input.slug)
        .where('id', '!=', id)
        .executeTakeFirst();
      if (taken) throw new AppError('SLUG_TAKEN', 'Slug is already used by another novel', 409);
    }
    const { category_ids: categoryIds, ...fields } = input;
    const merged = {
      title: fields.title ?? before.title,
      alt_titles: fields.alt_titles ?? before.alt_titles,
      author: fields.author !== undefined ? fields.author : before.author,
    };
    const publishing = fields.status === 'published' && before.published_at === null;
    await trx
      .updateTable('novels')
      .set({
        ...fields,
        search_text: buildSearchText(merged),
        ...(publishing ? { published_at: new Date() } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    if (categoryIds) await setCategories(trx, id, categoryIds);
    await insertAudit(trx, actor, 'NOVEL_UPDATED', 'novel', id, { changes: input }, ip);
  });
  return getAdminNovel(id);
}

// Hard-deletes a novel nobody has interacted with (typically a bad import); anything with reader
// history or paid unlocks is archived instead, so unlock/ledger references stay meaningful.
export async function deleteNovel(
  id: string,
  actor: NovelActor,
  ip: string,
): Promise<{ deleted: boolean; archived: boolean }> {
  return db.transaction().execute(async (trx) => {
    const novel = await trx
      .selectFrom('novels')
      .select(['id', 'title', 'cover_key'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!novel) throw new AppError('NOVEL_NOT_FOUND', 'Novel not found', 404);
    const [unlock, progress] = await Promise.all([
      trx
        .selectFrom('novel_chapter_unlocks')
        .select('id')
        .where('novel_id', '=', id)
        .limit(1)
        .executeTakeFirst(),
      trx
        .selectFrom('novel_read_progress')
        .select('id')
        .where('novel_id', '=', id)
        .limit(1)
        .executeTakeFirst(),
    ]);
    if (unlock || progress) {
      await trx
        .updateTable('novels')
        .set({ status: 'archived', updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      await insertAudit(trx, actor, 'NOVEL_ARCHIVED', 'novel', id, { title: novel.title }, ip);
      return { deleted: false, archived: true };
    }
    await trx.deleteFrom('novel_library').where('novel_id', '=', id).execute();
    await trx.deleteFrom('novels').where('id', '=', id).execute();
    await insertAudit(trx, actor, 'NOVEL_DELETED', 'novel', id, { title: novel.title }, ip);
    return { deleted: true, archived: false };
  });
}

const BULK_STATUS: Partial<Record<BulkNovelAction['action'], NovelStatus>> = {
  publish: 'published',
  hide: 'hidden',
  archive: 'archived',
  draft: 'draft',
};

export async function bulkNovels(
  input: BulkNovelAction,
  actor: NovelActor,
  ip: string,
): Promise<{ updated: number }> {
  return db.transaction().execute(async (trx) => {
    const now = new Date();
    let updated = 0;
    const status = BULK_STATUS[input.action];
    if (status) {
      const result = await trx
        .updateTable('novels')
        .set({
          status,
          updated_at: now,
          ...(status === 'published'
            ? { published_at: sql<Date>`coalesce(published_at, ${now})` }
            : {}),
        })
        .where('id', 'in', input.ids)
        .executeTakeFirst();
      updated = Number(result.numUpdatedRows);
    } else if (input.action === 'feature' || input.action === 'unfeature') {
      const result = await trx
        .updateTable('novels')
        .set({ is_featured: input.action === 'feature', updated_at: now })
        .where('id', 'in', input.ids)
        .executeTakeFirst();
      updated = Number(result.numUpdatedRows);
    } else {
      if (!input.category_id) {
        throw new AppError('CATEGORY_REQUIRED', 'category_id is required for this action', 400);
      }
      const categoryId = input.category_id;
      const category = await trx
        .selectFrom('novel_categories')
        .select('id')
        .where('id', '=', categoryId)
        .executeTakeFirst();
      if (!category) throw new AppError('CATEGORY_NOT_FOUND', 'Category not found', 404);
      const existing = await trx
        .selectFrom('novels')
        .select('id')
        .where('id', 'in', input.ids)
        .execute();
      if (input.action === 'add_category') {
        if (existing.length > 0) {
          const result = await trx
            .insertInto('novel_category_links')
            .values(existing.map((row) => ({ novel_id: row.id, category_id: categoryId })))
            .onConflict((oc) => oc.doNothing())
            .executeTakeFirst();
          updated = Number(result.numInsertedOrUpdatedRows ?? 0);
        }
      } else {
        const result = await trx
          .deleteFrom('novel_category_links')
          .where('category_id', '=', categoryId)
          .where('novel_id', 'in', input.ids)
          .executeTakeFirst();
        updated = Number(result.numDeletedRows);
      }
    }
    await insertAudit(trx, actor, 'NOVEL_BULK_ACTION', 'novel', null, { ...input }, ip);
    return { updated };
  });
}

export async function setNovelCover(
  id: string,
  cover: { url: string; key: string },
  actor: NovelActor,
  ip: string,
): Promise<{ previousKey: string | null; novel: AdminNovel }> {
  const previousKey = await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('novels')
      .select(['cover_key'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError('NOVEL_NOT_FOUND', 'Novel not found', 404);
    await trx
      .updateTable('novels')
      .set({ cover_url: cover.url, cover_key: cover.key, updated_at: new Date() })
      .where('id', '=', id)
      .execute();
    await insertAudit(trx, actor, 'NOVEL_COVER_UPDATED', 'novel', id, { key: cover.key }, ip);
    return before.cover_key;
  });
  return { previousKey, novel: await getAdminNovel(id) };
}

// ---------------------------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------------------------

interface ChapterRow {
  id: string;
  novel_id: string;
  chapter_no: number;
  title: string;
  word_count: number;
  is_vip: boolean | null;
  unlock_coin_price: number | null;
  status: 'draft' | 'published';
  publish_at: Date | null;
  updated_at: Date;
}

function serializeChapter(row: ChapterRow, vipFromChapter: number | null): AdminChapterSummary {
  return {
    id: row.id,
    novel_id: row.novel_id,
    chapter_no: row.chapter_no,
    title: row.title,
    word_count: row.word_count,
    is_vip: row.is_vip,
    effective_vip: isChapterVip(row, { vip_from_chapter: vipFromChapter }),
    unlock_coin_price: row.unlock_coin_price,
    status: row.status,
    publish_at: iso(row.publish_at),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

const CHAPTER_SUMMARY_COLUMNS = [
  'id',
  'novel_id',
  'chapter_no',
  'title',
  'word_count',
  'is_vip',
  'unlock_coin_price',
  'status',
  'publish_at',
  'updated_at',
] as const;

async function novelPolicy(
  executor: Trx | typeof db,
  novelId: string,
): Promise<{ vip_from_chapter: number | null }> {
  const novel = await executor
    .selectFrom('novels')
    .select('vip_from_chapter')
    .where('id', '=', novelId)
    .executeTakeFirst();
  if (!novel) throw new AppError('NOVEL_NOT_FOUND', 'Novel not found', 404);
  return novel;
}

export async function listAdminChapters(
  novelId: string,
  query: AdminChapterListQuery,
): Promise<{ items: AdminChapterSummary[]; next_after: number | null }> {
  const policy = await novelPolicy(db, novelId);
  const limit = query.limit ?? 200;
  let builder = db
    .selectFrom('novel_chapters')
    .select(CHAPTER_SUMMARY_COLUMNS)
    .where('novel_id', '=', novelId)
    .where('chapter_no', '>', query.after ?? 0);
  if (query.q) {
    builder = builder.where('title', 'ilike', `%${escapeLike(query.q)}%`);
  }
  const rows = await builder
    .orderBy('chapter_no')
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => serializeChapter(row, policy.vip_from_chapter)),
    next_after: rows.length > limit ? (page[page.length - 1]?.chapter_no ?? null) : null,
  };
}

export async function getAdminChapter(novelId: string, chapterId: string): Promise<AdminChapter> {
  const policy = await novelPolicy(db, novelId);
  const row = await db
    .selectFrom('novel_chapters')
    .select([...CHAPTER_SUMMARY_COLUMNS, 'content'])
    .where('id', '=', chapterId)
    .where('novel_id', '=', novelId)
    .executeTakeFirst();
  if (!row) throw new AppError('CHAPTER_NOT_FOUND', 'Chapter not found', 404);
  return { ...serializeChapter(row, policy.vip_from_chapter), content: row.content };
}

async function assertChapterNoFree(
  trx: Trx,
  novelId: string,
  chapterNo: number,
  excludeId?: string,
): Promise<void> {
  let query = trx
    .selectFrom('novel_chapters')
    .select('id')
    .where('novel_id', '=', novelId)
    .where('chapter_no', '=', chapterNo);
  if (excludeId) query = query.where('id', '!=', excludeId);
  if (await query.executeTakeFirst()) {
    throw new AppError('CHAPTER_NO_TAKEN', `Chapter ${String(chapterNo)} already exists`, 409);
  }
}

export async function createChapter(
  novelId: string,
  input: CreateChapterInput,
  actor: NovelActor,
  ip: string,
): Promise<AdminChapter> {
  const chapterId = await db.transaction().execute(async (trx) => {
    // Locking the novel serializes concurrent "append" requests on the next chapter number.
    const novel = await trx
      .selectFrom('novels')
      .select('id')
      .where('id', '=', novelId)
      .forUpdate()
      .executeTakeFirst();
    if (!novel) throw new AppError('NOVEL_NOT_FOUND', 'Novel not found', 404);
    let chapterNo = input.chapter_no;
    if (chapterNo === undefined) {
      const last = await trx
        .selectFrom('novel_chapters')
        .select((eb) => eb.fn.max('chapter_no').as('max'))
        .where('novel_id', '=', novelId)
        .executeTakeFirstOrThrow();
      // max() is NULL for a novel with no chapters yet, which Kysely's typing doesn't reflect.
      chapterNo = ((last.max as number | null) ?? 0) + 1;
    } else {
      await assertChapterNoFree(trx, novelId, chapterNo);
    }
    const content = normalizeContent(input.content);
    const id = uuidv7();
    await trx
      .insertInto('novel_chapters')
      .values({
        id,
        novel_id: novelId,
        chapter_no: chapterNo,
        title: (input.title ?? '').trim(),
        content,
        word_count: countWords(content),
        is_vip: input.is_vip ?? null,
        unlock_coin_price: input.unlock_coin_price ?? null,
        status: input.status ?? 'draft',
        publish_at: input.publish_at ? new Date(input.publish_at) : null,
      })
      .execute();
    await refreshNovelCounters(trx, novelId);
    await insertAudit(
      trx,
      actor,
      'NOVEL_CHAPTER_CREATED',
      'novel_chapter',
      id,
      { novel_id: novelId, chapter_no: chapterNo },
      ip,
    );
    return id;
  });
  return getAdminChapter(novelId, chapterId);
}

export async function updateChapter(
  novelId: string,
  chapterId: string,
  input: UpdateChapterInput,
  actor: NovelActor,
  ip: string,
): Promise<AdminChapter> {
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('novel_chapters')
      .selectAll()
      .where('id', '=', chapterId)
      .where('novel_id', '=', novelId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError('CHAPTER_NOT_FOUND', 'Chapter not found', 404);
    if (input.chapter_no !== undefined && input.chapter_no !== before.chapter_no) {
      await assertChapterNoFree(trx, novelId, input.chapter_no, chapterId);
    }
    const content = input.content !== undefined ? normalizeContent(input.content) : undefined;
    const title = input.title !== undefined ? input.title.trim() : undefined;
    // Keep the text being replaced, so an editor can roll a bad edit back.
    if (
      (content !== undefined && content !== before.content) ||
      (title !== undefined && title !== before.title)
    ) {
      await trx
        .insertInto('novel_chapter_revisions')
        .values({
          id: uuidv7(),
          chapter_id: chapterId,
          title: before.title,
          content: before.content,
          edited_by: actor.id,
        })
        .execute();
    }
    await trx
      .updateTable('novel_chapters')
      .set({
        ...(input.chapter_no !== undefined ? { chapter_no: input.chapter_no } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(content !== undefined ? { content, word_count: countWords(content) } : {}),
        ...(input.is_vip !== undefined ? { is_vip: input.is_vip } : {}),
        ...(input.unlock_coin_price !== undefined
          ? { unlock_coin_price: input.unlock_coin_price }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.publish_at !== undefined
          ? { publish_at: input.publish_at ? new Date(input.publish_at) : null }
          : {}),
        updated_at: new Date(),
      })
      .where('id', '=', chapterId)
      .execute();
    await refreshNovelCounters(trx, novelId);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- content is too large to audit
    const { content: _omitContent, ...auditedChanges } = input;
    await insertAudit(
      trx,
      actor,
      'NOVEL_CHAPTER_UPDATED',
      'novel_chapter',
      chapterId,
      {
        novel_id: novelId,
        changes: auditedChanges,
        content_changed: content !== undefined && content !== before.content,
      },
      ip,
    );
  });
  return getAdminChapter(novelId, chapterId);
}

export async function deleteChapter(
  novelId: string,
  chapterId: string,
  actor: NovelActor,
  ip: string,
): Promise<{ deleted: boolean }> {
  return db.transaction().execute(async (trx) => {
    const unlocked = await trx
      .selectFrom('novel_chapter_unlocks')
      .select('id')
      .where('chapter_id', '=', chapterId)
      .limit(1)
      .executeTakeFirst();
    if (unlocked) {
      // Users paid for this chapter; deleting it would silently take away what they bought.
      throw new AppError(
        'CHAPTER_HAS_UNLOCKS',
        'Readers have unlocked this chapter — set it to draft instead of deleting it',
        409,
      );
    }
    const deleted = await trx
      .deleteFrom('novel_chapters')
      .where('id', '=', chapterId)
      .where('novel_id', '=', novelId)
      .returning(['chapter_no'])
      .executeTakeFirst();
    if (!deleted) throw new AppError('CHAPTER_NOT_FOUND', 'Chapter not found', 404);
    await refreshNovelCounters(trx, novelId);
    await insertAudit(
      trx,
      actor,
      'NOVEL_CHAPTER_DELETED',
      'novel_chapter',
      chapterId,
      { novel_id: novelId, chapter_no: deleted.chapter_no },
      ip,
    );
    return { deleted: true };
  });
}

export async function bulkChapters(
  novelId: string,
  input: BulkChapterAction,
  actor: NovelActor,
  ip: string,
): Promise<{ updated: number }> {
  return db.transaction().execute(async (trx) => {
    await novelPolicy(trx, novelId);
    const now = new Date();
    const scope = trx
      .updateTable('novel_chapters')
      .where('novel_id', '=', novelId)
      .where('id', 'in', input.ids);
    let updated = 0;
    switch (input.action) {
      case 'delete': {
        const unlocked = await trx
          .selectFrom('novel_chapter_unlocks')
          .select('chapter_id')
          .where('chapter_id', 'in', input.ids)
          .limit(1)
          .executeTakeFirst();
        if (unlocked) {
          throw new AppError(
            'CHAPTER_HAS_UNLOCKS',
            'Some selected chapters have been unlocked by readers',
            409,
          );
        }
        const result = await trx
          .deleteFrom('novel_chapters')
          .where('novel_id', '=', novelId)
          .where('id', 'in', input.ids)
          .executeTakeFirst();
        updated = Number(result.numDeletedRows);
        break;
      }
      case 'schedule': {
        if (input.publish_at === undefined) {
          throw new AppError('PUBLISH_AT_REQUIRED', 'publish_at is required for this action', 400);
        }
        const result = await scope
          .set({
            status: 'published',
            publish_at: input.publish_at ? new Date(input.publish_at) : null,
            updated_at: now,
          })
          .executeTakeFirst();
        updated = Number(result.numUpdatedRows);
        break;
      }
      case 'set_price': {
        if (input.unlock_coin_price === undefined) {
          throw new AppError(
            'PRICE_REQUIRED',
            'unlock_coin_price is required for this action',
            400,
          );
        }
        const result = await scope
          .set({ unlock_coin_price: input.unlock_coin_price, updated_at: now })
          .executeTakeFirst();
        updated = Number(result.numUpdatedRows);
        break;
      }
      default: {
        const changes = {
          publish: { status: 'published' as const },
          draft: { status: 'draft' as const },
          set_vip: { is_vip: true },
          set_free: { is_vip: false },
          inherit_vip: { is_vip: null },
        }[input.action];
        const result = await scope.set({ ...changes, updated_at: now }).executeTakeFirst();
        updated = Number(result.numUpdatedRows);
      }
    }
    await refreshNovelCounters(trx, novelId);
    await insertAudit(
      trx,
      actor,
      'NOVEL_CHAPTER_BULK_ACTION',
      'novel',
      novelId,
      {
        action: input.action,
        count: input.ids.length,
        unlock_coin_price: input.unlock_coin_price,
        publish_at: input.publish_at,
      },
      ip,
    );
    return { updated };
  });
}

// Closes numbering gaps: keeps chapter order and makes numbers 1..N. The unique constraint is
// deferred for this transaction so the shift does not trip on intermediate collisions.
export async function renumberChapters(
  novelId: string,
  actor: NovelActor,
  ip: string,
): Promise<{ renumbered: number }> {
  return db.transaction().execute(async (trx) => {
    await novelPolicy(trx, novelId);
    await sql`SET CONSTRAINTS novel_chapters_novel_no_uniq DEFERRED`.execute(trx);
    const result = await sql`
      UPDATE novel_chapters c
      SET chapter_no = ordered.new_no, updated_at = now()
      FROM (
        SELECT id, row_number() OVER (ORDER BY chapter_no, created_at) AS new_no
        FROM novel_chapters WHERE novel_id = ${novelId}
      ) ordered
      WHERE c.id = ordered.id AND c.chapter_no <> ordered.new_no
    `.execute(trx);
    const renumbered = Number(result.numAffectedRows ?? 0);
    await insertAudit(
      trx,
      actor,
      'NOVEL_CHAPTERS_RENUMBERED',
      'novel',
      novelId,
      { renumbered },
      ip,
    );
    return { renumbered };
  });
}

export async function listRevisions(
  novelId: string,
  chapterId: string,
): Promise<{
  items: {
    id: string;
    title: string;
    content: string;
    edited_by: string | null;
    created_at: string;
  }[];
}> {
  const chapter = await db
    .selectFrom('novel_chapters')
    .select('id')
    .where('id', '=', chapterId)
    .where('novel_id', '=', novelId)
    .executeTakeFirst();
  if (!chapter) throw new AppError('CHAPTER_NOT_FOUND', 'Chapter not found', 404);
  const rows = await db
    .selectFrom('novel_chapter_revisions')
    .leftJoin('admin_users', 'admin_users.id', 'novel_chapter_revisions.edited_by')
    .select([
      'novel_chapter_revisions.id',
      'novel_chapter_revisions.title',
      'novel_chapter_revisions.content',
      'admin_users.email as edited_by',
      'novel_chapter_revisions.created_at',
    ])
    .where('novel_chapter_revisions.chapter_id', '=', chapterId)
    .orderBy('novel_chapter_revisions.created_at', 'desc')
    .limit(50)
    .execute();
  return {
    items: rows.map((row) => ({ ...row, created_at: new Date(row.created_at).toISOString() })),
  };
}

export async function restoreRevision(
  novelId: string,
  chapterId: string,
  revisionId: string,
  actor: NovelActor,
  ip: string,
): Promise<AdminChapter> {
  const revision = await db
    .selectFrom('novel_chapter_revisions')
    .select(['title', 'content'])
    .where('id', '=', revisionId)
    .where('chapter_id', '=', chapterId)
    .executeTakeFirst();
  if (!revision) throw new AppError('REVISION_NOT_FOUND', 'Revision not found', 404);
  return updateChapter(
    novelId,
    chapterId,
    { title: revision.title, content: revision.content },
    actor,
    ip,
  );
}
