import { sql } from 'kysely';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import {
  chapterUnlockPrice,
  chapterVisible,
  chapterLockedError,
  findReadableChapter,
  hasUnlocked,
  isChapterVip,
  loadReader,
  novelVisibleTo,
  type Reader,
} from './access.js';
import { parseNovelFeature, requiredReadSeconds, type NovelFeature } from './region-feature.js';
import { foldForSearch } from './text.js';
import type {
  ChapterReadResponse,
  ChapterTocItem,
  ListChaptersQuery,
  ListNovelsQuery,
  LibraryQuery,
  NovelDetail,
  NovelSummary,
} from './schemas.js';

const DEFAULT_PAGE_SIZE = 20;
const HOME_SECTION_SIZE = 10;
const CONTINUE_READING_SIZE = 5;
const POPULAR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TOC_PAGE_SIZE = 100;

const SUMMARY_COLUMNS = [
  'novels.id',
  'novels.slug',
  'novels.title',
  'novels.author',
  'novels.cover_url',
  'novels.description',
  'novels.completion_status',
  'novels.tags',
  'novels.chapter_count',
  'novels.word_count',
  'novels.updated_at',
  'novels.language',
  'novels.rating',
  'novels.read_count',
  'novels.ai_generated',
  'novels.editor_reviewed',
] as const;

interface SummaryRow {
  id: string;
  slug: string;
  title: string;
  author: string | null;
  cover_url: string | null;
  description: string | null;
  completion_status: string;
  tags: string[];
  chapter_count: number;
  word_count: string;
  updated_at: Date;
  language: string;
  rating: string | null;
  read_count: string;
  ai_generated: boolean;
  editor_reviewed: boolean;
}

async function toSummaries(rows: readonly SummaryRow[]): Promise<NovelSummary[]> {
  if (rows.length === 0) return [];
  const links = await db
    .selectFrom('novel_category_links')
    .innerJoin('novel_categories', 'novel_categories.id', 'novel_category_links.category_id')
    .select([
      'novel_category_links.novel_id',
      'novel_categories.id',
      'novel_categories.slug',
      'novel_categories.name',
    ])
    .where(
      'novel_category_links.novel_id',
      'in',
      rows.map((row) => row.id),
    )
    .where('novel_categories.is_active', '=', true)
    .orderBy('novel_categories.sort_order')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    author: row.author,
    cover_url: row.cover_url,
    description: row.description,
    completion_status: row.completion_status,
    tags: row.tags,
    categories: links
      .filter((link) => link.novel_id === row.id)
      .map((link) => ({ id: link.id, slug: link.slug, name: link.name })),
    chapter_count: row.chapter_count,
    word_count: Number(row.word_count),
    updated_at: new Date(row.updated_at).toISOString(),
    language: row.language,
    rating: row.rating === null ? null : Number(row.rating),
    read_count: Number(row.read_count),
    ai_generated: row.ai_generated,
    editor_reviewed: row.editor_reviewed,
  }));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

export async function listNovels(
  userId: string,
  query: ListNovelsQuery,
): Promise<{ items: NovelSummary[]; next_cursor: string | null }> {
  const reader = await loadReader(userId);
  const limit = query.limit ?? DEFAULT_PAGE_SIZE;
  const offset = Number(query.cursor ?? 0);

  let builder = db.selectFrom('novels').select(SUMMARY_COLUMNS).where(novelVisibleTo(reader));
  const q = query.q ? foldForSearch(query.q) : '';
  if (q !== '') {
    builder = builder.where('novels.search_text', 'ilike', `%${escapeLike(q)}%`);
  }
  if (query.category) {
    const category = query.category;
    builder = builder.where((eb) =>
      eb.exists(
        eb
          .selectFrom('novel_category_links')
          .innerJoin('novel_categories', 'novel_categories.id', 'novel_category_links.category_id')
          .select('novel_category_links.novel_id')
          .whereRef('novel_category_links.novel_id', '=', 'novels.id')
          .where('novel_categories.slug', '=', category),
      ),
    );
  }
  if (query.tag) {
    builder = builder.where(sql<boolean>`${query.tag} = ANY(novels.tags)`);
  }
  if (query.completion_status) {
    builder = builder.where('novels.completion_status', '=', query.completion_status);
  }

  switch (query.sort ?? 'updated') {
    case 'new':
      builder = builder
        .orderBy(sql`novels.published_at DESC NULLS LAST`)
        .orderBy('novels.id', 'desc');
      break;
    case 'popular':
      builder = builder
        .orderBy(
          sql`(SELECT count(*) FROM novel_library WHERE novel_library.novel_id = novels.id)`,
          'desc',
        )
        .orderBy('novels.id', 'desc');
      break;
    default:
      builder = builder.orderBy('novels.updated_at', 'desc').orderBy('novels.id', 'desc');
  }

  // Offset rather than keyset: "popular" orders by an aggregate with no stable key, and the catalog
  // is small enough that deep offsets are not a concern.
  const rows = await builder
    .limit(limit + 1)
    .offset(offset)
    .execute();
  const page = rows.slice(0, limit);
  return {
    items: await toSummaries(page),
    next_cursor: rows.length > limit ? String(offset + limit) : null,
  };
}

export async function listCategories(): Promise<{
  items: { id: string; slug: string; name: string }[];
}> {
  const items = await db
    .selectFrom('novel_categories')
    .select(['id', 'slug', 'name'])
    .where('is_active', '=', true)
    .orderBy('sort_order')
    .orderBy('name')
    .execute();
  return { items };
}

export async function getHome(userId: string): Promise<{
  featured: NovelSummary[];
  latest: NovelSummary[];
  popular: NovelSummary[];
  continue_reading: {
    novel: NovelSummary;
    last_chapter_no: number | null;
    last_read_at: string | null;
  }[];
}> {
  const reader = await loadReader(userId);
  const since = new Date(Date.now() - POPULAR_WINDOW_MS);
  const [featured, latest, popular, recent] = await Promise.all([
    db
      .selectFrom('novels')
      .select(SUMMARY_COLUMNS)
      .where(novelVisibleTo(reader))
      .where('novels.is_featured', '=', true)
      .orderBy('novels.featured_rank')
      .orderBy('novels.updated_at', 'desc')
      .limit(HOME_SECTION_SIZE)
      .execute(),
    db
      .selectFrom('novels')
      .select(SUMMARY_COLUMNS)
      .where(novelVisibleTo(reader))
      .orderBy('novels.updated_at', 'desc')
      .limit(HOME_SECTION_SIZE)
      .execute(),
    db
      .selectFrom('novels')
      .select(SUMMARY_COLUMNS)
      .where(novelVisibleTo(reader))
      .orderBy(
        sql`(SELECT count(DISTINCT p.user_id) FROM novel_read_progress p WHERE p.novel_id = novels.id AND p.created_at >= ${since})`,
        'desc',
      )
      .orderBy('novels.updated_at', 'desc')
      .limit(HOME_SECTION_SIZE)
      .execute(),
    db
      .selectFrom('novel_library')
      .innerJoin('novels', 'novels.id', 'novel_library.novel_id')
      .select([...SUMMARY_COLUMNS, 'novel_library.last_chapter_no', 'novel_library.last_read_at'])
      .where('novel_library.user_id', '=', reader.id)
      .where('novel_library.last_read_at', 'is not', null)
      .where(novelVisibleTo(reader))
      .orderBy('novel_library.last_read_at', 'desc')
      .limit(CONTINUE_READING_SIZE)
      .execute(),
  ]);
  const recentSummaries = await toSummaries(recent);
  return {
    featured: await toSummaries(featured),
    latest: await toSummaries(latest),
    popular: await toSummaries(popular),
    continue_reading: recent.flatMap((row, index) => {
      const novel = recentSummaries[index];
      if (!novel) return [];
      return [
        {
          novel,
          last_chapter_no: row.last_chapter_no,
          last_read_at: row.last_read_at ? new Date(row.last_read_at).toISOString() : null,
        },
      ];
    }),
  };
}

interface VisibleNovel extends SummaryRow {
  alt_titles: string[];
  translator: string | null;
  vip_from_chapter: number | null;
  default_unlock_coin: number;
  allow_ad_unlock: boolean;
}

async function findVisibleNovel(reader: Reader, novelId: string): Promise<VisibleNovel> {
  const novel = await db
    .selectFrom('novels')
    .select([
      ...SUMMARY_COLUMNS,
      'novels.alt_titles',
      'novels.translator',
      'novels.vip_from_chapter',
      'novels.default_unlock_coin',
      'novels.allow_ad_unlock',
    ])
    .where('novels.id', '=', novelId)
    .where(novelVisibleTo(reader))
    .executeTakeFirst();
  if (!novel) throw new AppError('NOVEL_NOT_FOUND', 'Novel not found', 404);
  return novel;
}

export async function getNovel(userId: string, novelId: string): Promise<NovelDetail> {
  const reader = await loadReader(userId);
  const novel = await findVisibleNovel(reader, novelId);
  const library = await db
    .selectFrom('novel_library')
    .select(['in_bookshelf', 'last_chapter_no', 'last_read_at'])
    .where('user_id', '=', reader.id)
    .where('novel_id', '=', novelId)
    .executeTakeFirst();
  const [summary] = await toSummaries([novel]);
  if (!summary) throw new AppError('NOVEL_NOT_FOUND', 'Novel not found', 404);
  return {
    ...summary,
    alt_titles: novel.alt_titles,
    translator: novel.translator,
    vip_from_chapter: novel.vip_from_chapter,
    default_unlock_coin: novel.default_unlock_coin,
    allow_ad_unlock: novel.allow_ad_unlock,
    library: {
      in_bookshelf: library?.in_bookshelf ?? false,
      last_chapter_no: library?.last_chapter_no ?? null,
      last_read_at: library?.last_read_at ? new Date(library.last_read_at).toISOString() : null,
    },
  };
}

export async function listChapters(
  userId: string,
  novelId: string,
  query: ListChaptersQuery,
): Promise<{ items: ChapterTocItem[]; next_after: number | null }> {
  const reader = await loadReader(userId);
  const novel = await findVisibleNovel(reader, novelId);
  const limit = query.limit ?? DEFAULT_TOC_PAGE_SIZE;
  const rows = await db
    .selectFrom('novel_chapters')
    .select(['id', 'chapter_no', 'title', 'word_count', 'is_vip', 'unlock_coin_price'])
    .where('novel_id', '=', novelId)
    .where('chapter_no', '>', query.after ?? 0)
    .where(chapterVisible(new Date()))
    .orderBy('chapter_no')
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  const ids = page.map((row) => row.id);
  const [unlocks, rewarded] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .selectFrom('novel_chapter_unlocks')
            .select('chapter_id')
            .where('user_id', '=', reader.id)
            .where('chapter_id', 'in', ids)
            .execute(),
          db
            .selectFrom('novel_read_progress')
            .select('chapter_id')
            .where('user_id', '=', reader.id)
            .where('chapter_id', 'in', ids)
            .where('rewarded_at', 'is not', null)
            .execute(),
        ]);
  const unlockedIds = new Set(unlocks.map((row) => row.chapter_id));
  const rewardedIds = new Set(rewarded.map((row) => row.chapter_id));
  return {
    items: page.map((row) => {
      const vip = isChapterVip(row, novel);
      return {
        id: row.id,
        chapter_no: row.chapter_no,
        title: row.title,
        word_count: row.word_count,
        is_vip: vip,
        unlock_price: vip ? chapterUnlockPrice(row, novel) : 0,
        ad_unlock: vip && novel.allow_ad_unlock,
        unlocked: !vip || unlockedIds.has(row.id),
        rewarded: rewardedIds.has(row.id),
      };
    }),
    next_after: rows.length > limit ? (page[page.length - 1]?.chapter_no ?? null) : null,
  };
}

async function readerNovelFeature(reader: Reader): Promise<NovelFeature> {
  const region = await db
    .selectFrom('region_config')
    .select('features')
    .where('region_id', '=', reader.regionId)
    .executeTakeFirst();
  return parseNovelFeature(region?.features);
}

export async function readChapter(
  userId: string,
  novelId: string,
  chapterNo: number,
): Promise<ChapterReadResponse> {
  const reader = await loadReader(userId);
  const now = new Date();
  const chapter = await findReadableChapter(reader, { novelId, chapterNo }, now);
  const vip = isChapterVip(chapter, chapter);
  if (vip && !(await hasUnlocked(reader.id, chapter.id))) {
    throw chapterLockedError(chapter);
  }

  const [content, neighbours, progress, feature] = await Promise.all([
    db
      .selectFrom('novel_chapters')
      .select('content')
      .where('id', '=', chapter.id)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('novel_chapters')
      .select([
        sql<number | null>`max(chapter_no) FILTER (WHERE chapter_no < ${chapterNo})`.as('prev'),
        sql<number | null>`min(chapter_no) FILTER (WHERE chapter_no > ${chapterNo})`.as('next'),
      ])
      .where('novel_id', '=', novelId)
      .where(chapterVisible(now))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('novel_read_progress')
      .select(['read_time_s', 'rewarded_at'])
      .where('user_id', '=', reader.id)
      .where('chapter_id', '=', chapter.id)
      .executeTakeFirst(),
    readerNovelFeature(reader),
  ]);

  // Opening a chapter is the reliable "where did I stop" signal — heartbeats may never arrive.
  const opened = await db
    .insertInto('novel_library')
    .values({
      user_id: reader.id,
      novel_id: novelId,
      last_chapter_id: chapter.id,
      last_chapter_no: chapterNo,
      last_read_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'novel_id']).doUpdateSet({
        last_chapter_id: chapter.id,
        last_chapter_no: chapterNo,
        last_read_at: now,
        updated_at: now,
      }),
    )
    // xmax is 0 only on a freshly inserted row, so this is "first chapter this reader has opened".
    .returning(sql<boolean>`xmax = 0`.as('inserted'))
    .executeTakeFirstOrThrow();
  if (opened.inserted) {
    // updated_at deliberately untouched: it orders "recently updated", which means new content.
    await db
      .updateTable('novels')
      .set({ read_count: sql`read_count + 1` })
      .where('id', '=', novelId)
      .execute();
  }

  return {
    id: chapter.id,
    novel_id: chapter.novel_id,
    chapter_no: chapter.chapter_no,
    title: chapter.title,
    content: content.content,
    word_count: chapter.word_count,
    is_vip: vip,
    prev_chapter_no: neighbours.prev,
    next_chapter_no: neighbours.next,
    reward: {
      eligible: !vip && feature.enabled && feature.chapter_reward_coin > 0,
      coin: vip ? 0 : feature.chapter_reward_coin,
      required_seconds: requiredReadSeconds(chapter.word_count, feature),
      read_seconds: progress?.read_time_s ?? 0,
      rewarded: progress?.rewarded_at != null,
    },
  };
}

export async function getLibrary(
  userId: string,
  query: LibraryQuery,
): Promise<{
  items: {
    novel: NovelSummary;
    in_bookshelf: boolean;
    last_chapter_no: number | null;
    last_read_at: string | null;
  }[];
}> {
  const reader = await loadReader(userId);
  let builder = db
    .selectFrom('novel_library')
    .innerJoin('novels', 'novels.id', 'novel_library.novel_id')
    .select([
      ...SUMMARY_COLUMNS,
      'novel_library.in_bookshelf',
      'novel_library.last_chapter_no',
      'novel_library.last_read_at',
    ])
    .where('novel_library.user_id', '=', reader.id)
    .where(novelVisibleTo(reader));
  builder =
    (query.view ?? 'bookshelf') === 'bookshelf'
      ? builder
          .where('novel_library.in_bookshelf', '=', true)
          .orderBy('novel_library.updated_at', 'desc')
      : builder
          .where('novel_library.last_read_at', 'is not', null)
          .orderBy('novel_library.last_read_at', 'desc');
  const rows = await builder.limit(query.limit ?? 50).execute();
  const summaries = await toSummaries(rows);
  return {
    items: rows.flatMap((row, index) => {
      const novel = summaries[index];
      if (!novel) return [];
      return [
        {
          novel,
          in_bookshelf: row.in_bookshelf,
          last_chapter_no: row.last_chapter_no,
          last_read_at: row.last_read_at ? new Date(row.last_read_at).toISOString() : null,
        },
      ];
    }),
  };
}

export async function setBookshelf(
  userId: string,
  novelId: string,
  inBookshelf: boolean,
): Promise<{ novel_id: string; in_bookshelf: boolean }> {
  const reader = await loadReader(userId);
  const now = new Date();
  if (!inBookshelf) {
    await db
      .updateTable('novel_library')
      .set({ in_bookshelf: false, updated_at: now })
      .where('user_id', '=', reader.id)
      .where('novel_id', '=', novelId)
      .execute();
    return { novel_id: novelId, in_bookshelf: false };
  }
  await findVisibleNovel(reader, novelId);
  await db
    .insertInto('novel_library')
    .values({ user_id: reader.id, novel_id: novelId, in_bookshelf: true })
    .onConflict((oc) =>
      oc.columns(['user_id', 'novel_id']).doUpdateSet({ in_bookshelf: true, updated_at: now }),
    )
    .execute();
  return { novel_id: novelId, in_bookshelf: true };
}
