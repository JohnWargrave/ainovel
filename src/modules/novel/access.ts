import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';

export interface Reader {
  id: string;
  countryCode: string;
  regionId: string;
}

// Browsing is open to suspended accounts (they can still read); only earning checks standing, via
// loadUserRegionFeatures in reading.service.ts. A banned account is shut out entirely.
export async function loadReader(userId: string): Promise<Reader> {
  const user = await db
    .selectFrom('users')
    .select(['id', 'country_code', 'region_id', 'status'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
  if (user.status === 'banned') {
    throw new AppError('ACCOUNT_BLOCKED', 'This account is blocked', 403);
  }
  return { id: user.id, countryCode: user.country_code, regionId: user.region_id };
}

// Published, and licensed for the reader's country or region (NULL regions = everywhere) — same
// country-or-region convention as catalog_items.regions. Raw SQL so it composes into any query that
// has `novels` in scope.
export function novelVisibleTo(reader: Reader): RawBuilder<SqlBool> {
  return sql<SqlBool>`(novels.status = 'published' AND (novels.regions IS NULL OR novels.regions && ARRAY[${reader.countryCode}, ${reader.regionId}]::text[]))`;
}

// Published and past its scheduled publish time. Needs `novel_chapters` in scope.
export function chapterVisible(now: Date): RawBuilder<SqlBool> {
  return sql<SqlBool>`(novel_chapters.status = 'published' AND (novel_chapters.publish_at IS NULL OR novel_chapters.publish_at <= ${now}))`;
}

export interface VipPolicy {
  vip_from_chapter: number | null;
  default_unlock_coin: number;
  allow_ad_unlock: boolean;
}

export function isChapterVip(
  chapter: { chapter_no: number; is_vip: boolean | null },
  novel: Pick<VipPolicy, 'vip_from_chapter'>,
): boolean {
  if (chapter.is_vip !== null) return chapter.is_vip;
  return novel.vip_from_chapter !== null && chapter.chapter_no >= novel.vip_from_chapter;
}

export function chapterUnlockPrice(
  chapter: { unlock_coin_price: number | null },
  novel: Pick<VipPolicy, 'default_unlock_coin'>,
): number {
  return chapter.unlock_coin_price ?? novel.default_unlock_coin;
}

export interface ReadableChapter {
  id: string;
  novel_id: string;
  chapter_no: number;
  title: string;
  word_count: number;
  is_vip: boolean | null;
  unlock_coin_price: number | null;
  vip_from_chapter: number | null;
  default_unlock_coin: number;
  allow_ad_unlock: boolean;
}

// A chapter the reader is allowed to see exists (VIP or not), else 404. Never distinguishes "does
// not exist" from "not licensed here" or "not published yet".
export async function findReadableChapter(
  reader: Reader,
  where: { chapterId: string } | { novelId: string; chapterNo: number },
  now = new Date(),
): Promise<ReadableChapter> {
  let query = db
    .selectFrom('novel_chapters')
    .innerJoin('novels', 'novels.id', 'novel_chapters.novel_id')
    .select([
      'novel_chapters.id',
      'novel_chapters.novel_id',
      'novel_chapters.chapter_no',
      'novel_chapters.title',
      'novel_chapters.word_count',
      'novel_chapters.is_vip',
      'novel_chapters.unlock_coin_price',
      'novels.vip_from_chapter',
      'novels.default_unlock_coin',
      'novels.allow_ad_unlock',
    ])
    .where(novelVisibleTo(reader))
    .where(chapterVisible(now));
  query =
    'chapterId' in where
      ? query.where('novel_chapters.id', '=', where.chapterId)
      : query
          .where('novel_chapters.novel_id', '=', where.novelId)
          .where('novel_chapters.chapter_no', '=', where.chapterNo);
  const chapter = await query.executeTakeFirst();
  if (!chapter) throw new AppError('CHAPTER_NOT_FOUND', 'Chapter not found', 404);
  return chapter;
}

export async function hasUnlocked(userId: string, chapterId: string): Promise<boolean> {
  const row = await db
    .selectFrom('novel_chapter_unlocks')
    .select('id')
    .where('user_id', '=', userId)
    .where('chapter_id', '=', chapterId)
    .executeTakeFirst();
  return row !== undefined;
}

export function chapterLockedError(chapter: ReadableChapter): AppError {
  return new AppError('CHAPTER_LOCKED', 'This chapter must be unlocked first', 403, undefined, {
    chapter_id: chapter.id,
    unlock_price: chapterUnlockPrice(chapter, chapter),
    ad_unlock: chapter.allow_ad_unlock,
  });
}
