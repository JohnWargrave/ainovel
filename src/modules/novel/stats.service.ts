import { sql } from 'kysely';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import type { NovelStats } from './admin-schemas.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getNovelStats(novelId: string, days: number): Promise<NovelStats> {
  const novel = await db
    .selectFrom('novels')
    .select('id')
    .where('id', '=', novelId)
    .executeTakeFirst();
  if (!novel) throw new AppError('NOVEL_NOT_FOUND', 'Novel not found', 404);
  const since = new Date(Date.now() - days * DAY_MS);

  const [reading, unlocks, coin, bookshelf, chapters] = await Promise.all([
    db
      .selectFrom('novel_read_progress')
      .select([
        sql<string>`count(DISTINCT user_id)`.as('readers'),
        sql<string>`count(*)`.as('chapter_reads'),
        sql<string>`count(*) FILTER (WHERE completed_at IS NOT NULL)`.as('completions'),
        sql<string>`count(*) FILTER (WHERE rewarded_at IS NOT NULL)`.as('rewarded'),
      ])
      .where('novel_id', '=', novelId)
      .where('created_at', '>=', since)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('novel_chapter_unlocks')
      .select([
        sql<string>`count(*) FILTER (WHERE method = 'coin')`.as('coin'),
        sql<string>`count(*) FILTER (WHERE method = 'ad')`.as('ad'),
        sql<string>`coalesce(sum(coin_spent), 0)`.as('spent'),
      ])
      .where('novel_id', '=', novelId)
      .where('created_at', '>=', since)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('coin_ledger')
      .innerJoin('novel_chapters', 'novel_chapters.id', 'coin_ledger.ref_id')
      .select(sql<string>`coalesce(sum(coin_ledger.amount), 0)`.as('rewarded'))
      .where('coin_ledger.entry_type', '=', 'NOVEL_READ_CREDIT')
      .where('novel_chapters.novel_id', '=', novelId)
      .where('coin_ledger.created_at', '>=', since)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('novel_library')
      .select(sql<string>`count(*)`.as('total'))
      .where('novel_id', '=', novelId)
      .where('in_bookshelf', '=', true)
      .executeTakeFirstOrThrow(),
    sql<{
      chapter_no: number;
      title: string;
      readers: string;
      completions: string;
      unlocks: string;
    }>`
      SELECT c.chapter_no, c.title,
             count(DISTINCT p.user_id) AS readers,
             count(DISTINCT p.user_id) FILTER (WHERE p.completed_at IS NOT NULL) AS completions,
             (SELECT count(*) FROM novel_chapter_unlocks u
              WHERE u.chapter_id = c.id AND u.created_at >= ${since}) AS unlocks
      FROM novel_chapters c
      LEFT JOIN novel_read_progress p ON p.chapter_id = c.id AND p.created_at >= ${since}
      WHERE c.novel_id = ${novelId}
      GROUP BY c.id
      ORDER BY c.chapter_no
      LIMIT 2000
    `.execute(db),
  ]);

  return {
    novel_id: novelId,
    days,
    readers: Number(reading.readers),
    chapter_reads: Number(reading.chapter_reads),
    completions: Number(reading.completions),
    rewarded_chapters: Number(reading.rewarded),
    coin_rewarded: Number(coin.rewarded),
    unlocks_coin: Number(unlocks.coin),
    unlocks_ad: Number(unlocks.ad),
    coin_spent: Number(unlocks.spent),
    bookshelf_count: Number(bookshelf.total),
    chapters: chapters.rows.map((row) => ({
      chapter_no: row.chapter_no,
      title: row.title,
      readers: Number(row.readers),
      completions: Number(row.completions),
      unlocks: Number(row.unlocks),
    })),
  };
}

export async function getTopNovels(days: number): Promise<{
  days: number;
  items: {
    novel_id: string;
    title: string;
    readers: number;
    completions: number;
    coin_rewarded: number;
    coin_spent: number;
  }[];
}> {
  const since = new Date(Date.now() - days * DAY_MS);
  const result = await sql<{
    novel_id: string;
    title: string;
    readers: string;
    completions: string;
    coin_spent: string;
  }>`
    SELECT n.id AS novel_id, n.title,
           coalesce(r.readers, 0) AS readers,
           coalesce(r.completions, 0) AS completions,
           coalesce(u.spent, 0) AS coin_spent
    FROM novels n
    LEFT JOIN (
      SELECT novel_id, count(DISTINCT user_id) AS readers,
             count(*) FILTER (WHERE completed_at IS NOT NULL) AS completions
      FROM novel_read_progress WHERE created_at >= ${since} GROUP BY novel_id
    ) r ON r.novel_id = n.id
    LEFT JOIN (
      SELECT novel_id, sum(coin_spent) AS spent
      FROM novel_chapter_unlocks WHERE created_at >= ${since} GROUP BY novel_id
    ) u ON u.novel_id = n.id
    WHERE r.readers IS NOT NULL OR u.spent IS NOT NULL
    ORDER BY coalesce(r.readers, 0) DESC, n.title
    LIMIT 50
  `.execute(db);
  const rewarded = await sql<{ novel_id: string; rewarded: string }>`
    SELECT c.novel_id, sum(l.amount) AS rewarded
    FROM coin_ledger l JOIN novel_chapters c ON c.id = l.ref_id
    WHERE l.entry_type = 'NOVEL_READ_CREDIT' AND l.created_at >= ${since}
    GROUP BY c.novel_id
  `.execute(db);
  const rewardedByNovel = new Map(rewarded.rows.map((row) => [row.novel_id, Number(row.rewarded)]));
  return {
    days,
    items: result.rows.map((row) => ({
      novel_id: row.novel_id,
      title: row.title,
      readers: Number(row.readers),
      completions: Number(row.completions),
      coin_rewarded: rewardedByNovel.get(row.novel_id) ?? 0,
      coin_spent: Number(row.coin_spent),
    })),
  };
}
