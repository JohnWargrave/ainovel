import { Type, type Static, type TNull, type TUnion } from '@sinclair/typebox';

const Uuid = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});
const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T): TUnion<[T, TNull]> =>
  Type.Union([schema, Type.Null()]);

export const NovelParamsSchema = Type.Object({ id: Uuid });
export type NovelParams = Static<typeof NovelParamsSchema>;
export const ChapterParamsSchema = Type.Object({ id: Uuid });
export type ChapterParams = Static<typeof ChapterParamsSchema>;
export const ReadChapterParamsSchema = Type.Object({
  id: Uuid,
  chapter_no: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
});
export type ReadChapterParams = Static<typeof ReadChapterParamsSchema>;

export const NovelSortSchema = Type.Union([
  Type.Literal('updated'),
  Type.Literal('new'),
  Type.Literal('popular'),
]);

export const ListNovelsQuerySchema = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 100 })),
  category: Type.Optional(Type.String({ maxLength: 80 })),
  tag: Type.Optional(Type.String({ maxLength: 80 })),
  completion_status: Type.Optional(
    Type.Union([Type.Literal('ongoing'), Type.Literal('completed'), Type.Literal('hiatus')]),
  ),
  sort: Type.Optional(NovelSortSchema),
  cursor: Type.Optional(Type.String({ pattern: '^[0-9]{1,6}$' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});
export type ListNovelsQuery = Static<typeof ListNovelsQuerySchema>;

export const CategorySchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  name: Type.String(),
});
export const CategoryListResponseSchema = Type.Object({ items: Type.Array(CategorySchema) });

export const NovelSummarySchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  title: Type.String(),
  author: Nullable(Type.String()),
  cover_url: Nullable(Type.String()),
  description: Nullable(Type.String()),
  completion_status: Type.String(),
  tags: Type.Array(Type.String()),
  categories: Type.Array(CategorySchema),
  chapter_count: Type.Integer(),
  word_count: Type.Integer(),
  updated_at: Type.String(),
});
export type NovelSummary = Static<typeof NovelSummarySchema>;

export const NovelListResponseSchema = Type.Object({
  items: Type.Array(NovelSummarySchema),
  next_cursor: Nullable(Type.String()),
});

export const HomeResponseSchema = Type.Object({
  featured: Type.Array(NovelSummarySchema),
  latest: Type.Array(NovelSummarySchema),
  popular: Type.Array(NovelSummarySchema),
  continue_reading: Type.Array(
    Type.Object({
      novel: NovelSummarySchema,
      last_chapter_no: Type.Union([Type.Integer(), Type.Null()]),
      last_read_at: Nullable(Type.String()),
    }),
  ),
});

export const LibraryStateSchema = Type.Object({
  in_bookshelf: Type.Boolean(),
  last_chapter_no: Type.Union([Type.Integer(), Type.Null()]),
  last_read_at: Nullable(Type.String()),
});

export const NovelDetailSchema = Type.Composite([
  NovelSummarySchema,
  Type.Object({
    alt_titles: Type.Array(Type.String()),
    translator: Nullable(Type.String()),
    language: Type.String(),
    vip_from_chapter: Type.Union([Type.Integer(), Type.Null()]),
    default_unlock_coin: Type.Integer(),
    allow_ad_unlock: Type.Boolean(),
    library: LibraryStateSchema,
  }),
]);
export type NovelDetail = Static<typeof NovelDetailSchema>;

export const ListChaptersQuerySchema = Type.Object({
  // Chapter number to continue after (keyset on chapter_no).
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
export type ListChaptersQuery = Static<typeof ListChaptersQuerySchema>;

export const ChapterTocItemSchema = Type.Object({
  id: Type.String(),
  chapter_no: Type.Integer(),
  title: Type.String(),
  word_count: Type.Integer(),
  is_vip: Type.Boolean(),
  unlock_price: Type.Integer(),
  ad_unlock: Type.Boolean(),
  unlocked: Type.Boolean(),
  rewarded: Type.Boolean(),
});
export type ChapterTocItem = Static<typeof ChapterTocItemSchema>;

export const ChapterTocResponseSchema = Type.Object({
  items: Type.Array(ChapterTocItemSchema),
  next_after: Type.Union([Type.Integer(), Type.Null()]),
});

export const ChapterReadResponseSchema = Type.Object({
  id: Type.String(),
  novel_id: Type.String(),
  chapter_no: Type.Integer(),
  title: Type.String(),
  content: Type.String(),
  word_count: Type.Integer(),
  is_vip: Type.Boolean(),
  prev_chapter_no: Type.Union([Type.Integer(), Type.Null()]),
  next_chapter_no: Type.Union([Type.Integer(), Type.Null()]),
  reward: Type.Object({
    // False for VIP chapters and when the region has reading rewards switched off.
    eligible: Type.Boolean(),
    coin: Type.Integer(),
    required_seconds: Type.Integer(),
    read_seconds: Type.Integer(),
    rewarded: Type.Boolean(),
  }),
});
export type ChapterReadResponse = Static<typeof ChapterReadResponseSchema>;

export const ReadHeartbeatBodySchema = Type.Object({
  chapter_id: Uuid,
  // How far down the chapter the reader is (0 = top, 1 = end).
  scroll_ratio: Type.Number({ minimum: 0, maximum: 1 }),
});
export type ReadHeartbeatBody = Static<typeof ReadHeartbeatBodySchema>;

export const ReadHeartbeatResponseSchema = Type.Object({
  // Server-verified reading time — what the reward is decided on.
  read_seconds: Type.Integer(),
  required_seconds: Type.Integer(),
  scroll_ratio: Type.Number(),
  reward_eligible: Type.Boolean(),
  // True on exactly one beat: the one that credited. The app fires its reward animation off this.
  rewarded: Type.Boolean(),
  credited_coin: Type.Integer(),
  // Wallet available balance as of this beat, on every beat.
  new_balance: Type.String(),
  daily_remaining: Type.Integer(),
});
export type ReadHeartbeatResponse = Static<typeof ReadHeartbeatResponseSchema>;

export const UnlockBodySchema = Type.Union([
  Type.Object({ method: Type.Literal('coin') }),
  Type.Object({ method: Type.Literal('ad'), intent_id: Uuid }),
]);
export type UnlockBody = Static<typeof UnlockBodySchema>;

export const UnlockResponseSchema = Type.Object({
  chapter_id: Type.String(),
  unlocked: Type.Boolean(),
  // 'free' when the chapter was never locked for this user.
  method: Type.Union([Type.Literal('coin'), Type.Literal('ad'), Type.Literal('free')]),
  coin_spent: Type.Integer(),
  new_balance: Type.String(),
});
export type UnlockResponse = Static<typeof UnlockResponseSchema>;

export const LibraryQuerySchema = Type.Object({
  view: Type.Optional(Type.Union([Type.Literal('bookshelf'), Type.Literal('history')])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type LibraryQuery = Static<typeof LibraryQuerySchema>;

export const LibraryResponseSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      novel: NovelSummarySchema,
      in_bookshelf: Type.Boolean(),
      last_chapter_no: Type.Union([Type.Integer(), Type.Null()]),
      last_read_at: Nullable(Type.String()),
    }),
  ),
});
