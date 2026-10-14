import { Type, type Static } from '@sinclair/typebox';
import { NOVEL_FEATURE_BOUNDS } from './region-feature.js';

const Uuid = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});
const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableInteger = Type.Union([Type.Integer(), Type.Null()]);

export const NovelStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('published'),
  Type.Literal('hidden'),
  Type.Literal('archived'),
]);
export const CompletionStatusSchema = Type.Union([
  Type.Literal('ongoing'),
  Type.Literal('completed'),
  Type.Literal('hiatus'),
]);
export const ChapterStatusSchema = Type.Union([Type.Literal('draft'), Type.Literal('published')]);

export const IdParamsSchema = Type.Object({ id: Uuid });
export type IdParams = Static<typeof IdParamsSchema>;
export const ChapterIdParamsSchema = Type.Object({ id: Uuid, chapter_id: Uuid });
export type ChapterIdParams = Static<typeof ChapterIdParamsSchema>;
export const RegionParamsSchema = Type.Object({
  region_id: Type.String({ minLength: 1, maxLength: 16 }),
});

// ---- Categories ----

export const AdminCategorySchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  sort_order: Type.Integer(),
  is_active: Type.Boolean(),
  novel_count: Type.Integer(),
});
export type AdminCategory = Static<typeof AdminCategorySchema>;
export const AdminCategoryListSchema = Type.Object({ items: Type.Array(AdminCategorySchema) });

export const CategoryInputSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  slug: Type.Optional(Type.String({ pattern: '^[a-z0-9-]{1,80}$' })),
  sort_order: Type.Optional(Type.Integer({ minimum: -100000, maximum: 100000 })),
  is_active: Type.Optional(Type.Boolean()),
});
export type CategoryInput = Static<typeof CategoryInputSchema>;

// ---- Novels ----

export const AdminNovelSchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  title: Type.String(),
  alt_titles: Type.Array(Type.String()),
  author: NullableString,
  translator: NullableString,
  description: NullableString,
  cover_url: NullableString,
  status: NovelStatusSchema,
  completion_status: CompletionStatusSchema,
  language: Type.String(),
  tags: Type.Array(Type.String()),
  regions: Type.Union([Type.Array(Type.String()), Type.Null()]),
  is_featured: Type.Boolean(),
  featured_rank: Type.Integer(),
  vip_from_chapter: NullableInteger,
  default_unlock_coin: Type.Integer(),
  allow_ad_unlock: Type.Boolean(),
  rating: Type.Union([Type.Number(), Type.Null()]),
  read_count: Type.Integer(),
  ai_generated: Type.Boolean(),
  editor_reviewed: Type.Boolean(),
  chapter_count: Type.Integer(),
  total_chapter_count: Type.Integer(),
  word_count: Type.Integer(),
  category_ids: Type.Array(Type.String()),
  published_at: NullableString,
  created_at: Type.String(),
  updated_at: Type.String(),
});
export type AdminNovel = Static<typeof AdminNovelSchema>;

export const AdminNovelListQuerySchema = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 100 })),
  status: Type.Optional(NovelStatusSchema),
  completion_status: Type.Optional(CompletionStatusSchema),
  category_id: Type.Optional(Uuid),
  language: Type.Optional(Type.String({ maxLength: 10 })),
  featured: Type.Optional(Type.Boolean()),
  sort: Type.Optional(
    Type.Union([Type.Literal('updated'), Type.Literal('created'), Type.Literal('title')]),
  ),
  cursor: Type.Optional(Type.String({ pattern: '^[0-9]{1,7}$' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type AdminNovelListQuery = Static<typeof AdminNovelListQuerySchema>;

export const AdminNovelListSchema = Type.Object({
  items: Type.Array(AdminNovelSchema),
  next_cursor: NullableString,
  total: Type.Integer(),
});

const NovelFields = {
  title: Type.String({ minLength: 1, maxLength: 300 }),
  slug: Type.String({ pattern: '^[a-z0-9-]{1,100}$' }),
  alt_titles: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 20 }),
  author: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  translator: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  description: Type.Union([Type.String({ maxLength: 20000 }), Type.Null()]),
  cover_url: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
  status: NovelStatusSchema,
  completion_status: CompletionStatusSchema,
  language: Type.String({ minLength: 2, maxLength: 10 }),
  tags: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 50 }),
  regions: Type.Union([
    Type.Array(Type.String({ minLength: 2, maxLength: 16 }), { maxItems: 300 }),
    Type.Null(),
  ]),
  is_featured: Type.Boolean(),
  featured_rank: Type.Integer({ minimum: -100000, maximum: 100000 }),
  vip_from_chapter: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  default_unlock_coin: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  allow_ad_unlock: Type.Boolean(),
  category_ids: Type.Array(Uuid, { maxItems: 20 }),
  // Shown on the app's story cards; null hides the stars. Stored to one decimal. Null comes first:
  // with coerceTypes, a number branch tried first would turn null into 0 and accept it.
  rating: Type.Union([Type.Null(), Type.Number({ minimum: 0, maximum: 5 })]),
  ai_generated: Type.Boolean(),
  editor_reviewed: Type.Boolean(),
};

export const CreateNovelSchema = Type.Object({
  title: NovelFields.title,
  slug: Type.Optional(NovelFields.slug),
  alt_titles: Type.Optional(NovelFields.alt_titles),
  author: Type.Optional(NovelFields.author),
  translator: Type.Optional(NovelFields.translator),
  description: Type.Optional(NovelFields.description),
  cover_url: Type.Optional(NovelFields.cover_url),
  status: Type.Optional(NovelFields.status),
  completion_status: Type.Optional(NovelFields.completion_status),
  language: Type.Optional(NovelFields.language),
  tags: Type.Optional(NovelFields.tags),
  regions: Type.Optional(NovelFields.regions),
  is_featured: Type.Optional(NovelFields.is_featured),
  featured_rank: Type.Optional(NovelFields.featured_rank),
  vip_from_chapter: Type.Optional(NovelFields.vip_from_chapter),
  default_unlock_coin: Type.Optional(NovelFields.default_unlock_coin),
  allow_ad_unlock: Type.Optional(NovelFields.allow_ad_unlock),
  category_ids: Type.Optional(NovelFields.category_ids),
  rating: Type.Optional(NovelFields.rating),
  ai_generated: Type.Optional(NovelFields.ai_generated),
  editor_reviewed: Type.Optional(NovelFields.editor_reviewed),
});
export type CreateNovelInput = Static<typeof CreateNovelSchema>;

export const UpdateNovelSchema = Type.Partial(Type.Object(NovelFields), { minProperties: 1 });
export type UpdateNovelInput = Static<typeof UpdateNovelSchema>;

export const BulkNovelActionSchema = Type.Object({
  ids: Type.Array(Uuid, { minItems: 1, maxItems: 200 }),
  action: Type.Union([
    Type.Literal('publish'),
    Type.Literal('hide'),
    Type.Literal('archive'),
    Type.Literal('draft'),
    Type.Literal('feature'),
    Type.Literal('unfeature'),
    Type.Literal('add_category'),
    Type.Literal('remove_category'),
  ]),
  category_id: Type.Optional(Uuid),
});
export type BulkNovelAction = Static<typeof BulkNovelActionSchema>;
export const BulkResultSchema = Type.Object({ updated: Type.Integer() });

// ---- Chapters ----

export const AdminChapterSummarySchema = Type.Object({
  id: Type.String(),
  novel_id: Type.String(),
  chapter_no: Type.Integer(),
  title: Type.String(),
  word_count: Type.Integer(),
  is_vip: Type.Union([Type.Boolean(), Type.Null()]),
  effective_vip: Type.Boolean(),
  unlock_coin_price: NullableInteger,
  status: ChapterStatusSchema,
  publish_at: NullableString,
  updated_at: Type.String(),
});
export type AdminChapterSummary = Static<typeof AdminChapterSummarySchema>;

export const AdminChapterSchema = Type.Composite([
  AdminChapterSummarySchema,
  Type.Object({ content: Type.String() }),
]);
export type AdminChapter = Static<typeof AdminChapterSchema>;

export const AdminChapterListQuerySchema = Type.Object({
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  q: Type.Optional(Type.String({ maxLength: 100 })),
});
export type AdminChapterListQuery = Static<typeof AdminChapterListQuerySchema>;
export const AdminChapterListSchema = Type.Object({
  items: Type.Array(AdminChapterSummarySchema),
  next_after: NullableInteger,
});

// A chapter body is plain text; 400k chars covers the longest web-novel chapters with room to spare.
const ChapterContent = Type.String({ maxLength: 400_000 });

export const CreateChapterSchema = Type.Object({
  // Omitted = append after the current last chapter.
  chapter_no: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  title: Type.Optional(Type.String({ maxLength: 300 })),
  content: ChapterContent,
  is_vip: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  unlock_coin_price: Type.Optional(
    Type.Union([Type.Integer({ minimum: 0, maximum: 1_000_000 }), Type.Null()]),
  ),
  status: Type.Optional(ChapterStatusSchema),
  publish_at: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
});
export type CreateChapterInput = Static<typeof CreateChapterSchema>;

export const UpdateChapterSchema = Type.Partial(
  Type.Object({
    chapter_no: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    title: Type.String({ maxLength: 300 }),
    content: ChapterContent,
    is_vip: Type.Union([Type.Boolean(), Type.Null()]),
    unlock_coin_price: Type.Union([Type.Integer({ minimum: 0, maximum: 1_000_000 }), Type.Null()]),
    status: ChapterStatusSchema,
    publish_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  }),
  { minProperties: 1 },
);
export type UpdateChapterInput = Static<typeof UpdateChapterSchema>;

export const BulkChapterActionSchema = Type.Object({
  ids: Type.Array(Uuid, { minItems: 1, maxItems: 2000 }),
  action: Type.Union([
    Type.Literal('publish'),
    Type.Literal('draft'),
    Type.Literal('set_vip'),
    Type.Literal('set_free'),
    Type.Literal('inherit_vip'),
    Type.Literal('set_price'),
    Type.Literal('schedule'),
    Type.Literal('delete'),
  ]),
  unlock_coin_price: Type.Optional(
    Type.Union([Type.Integer({ minimum: 0, maximum: 1_000_000 }), Type.Null()]),
  ),
  publish_at: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
});
export type BulkChapterAction = Static<typeof BulkChapterActionSchema>;

// Closes gaps left by deletes: chapters keep their order and become 1..N.
export const RenumberResultSchema = Type.Object({ renumbered: Type.Integer() });

export const ChapterRevisionSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  content: Type.String(),
  edited_by: NullableString,
  created_at: Type.String(),
});
export const ChapterRevisionListSchema = Type.Object({ items: Type.Array(ChapterRevisionSchema) });
export const RevisionParamsSchema = Type.Object({ id: Uuid, chapter_id: Uuid, revision_id: Uuid });
export type RevisionParams = Static<typeof RevisionParamsSchema>;

// ---- Region settings ----

const B = NOVEL_FEATURE_BOUNDS;
export const NovelRegionSettingsSchema = Type.Object({
  region_id: Type.String(),
  enabled: Type.Boolean(),
  chapter_reward_coin: Type.Integer(),
  reading_wpm: Type.Integer(),
  min_read_ratio: Type.Number(),
  min_read_seconds: Type.Integer(),
  max_read_seconds: Type.Integer(),
  completion_scroll_ratio: Type.Number(),
  chapter_reward_daily_cap: Type.Integer(),
  // Read-only context: the daily cap resets at midnight in this zone.
  timezone: Type.String(),
  updated_at: Type.String(),
});
export type NovelRegionSettings = Static<typeof NovelRegionSettingsSchema>;
export const NovelSettingsListSchema = Type.Object({
  items: Type.Array(NovelRegionSettingsSchema),
});

export const UpdateNovelRegionSettingsSchema = Type.Object({
  enabled: Type.Boolean(),
  chapter_reward_coin: Type.Integer({
    minimum: B.chapter_reward_coin.min,
    maximum: B.chapter_reward_coin.max,
  }),
  reading_wpm: Type.Integer({ minimum: B.reading_wpm.min, maximum: B.reading_wpm.max }),
  min_read_ratio: Type.Number({ minimum: B.min_read_ratio.min, maximum: B.min_read_ratio.max }),
  min_read_seconds: Type.Integer({
    minimum: B.min_read_seconds.min,
    maximum: B.min_read_seconds.max,
  }),
  max_read_seconds: Type.Integer({
    minimum: B.max_read_seconds.min,
    maximum: B.max_read_seconds.max,
  }),
  completion_scroll_ratio: Type.Number({
    minimum: B.completion_scroll_ratio.min,
    maximum: B.completion_scroll_ratio.max,
  }),
  chapter_reward_daily_cap: Type.Integer({
    minimum: B.chapter_reward_daily_cap.min,
    maximum: B.chapter_reward_daily_cap.max,
  }),
});
export type UpdateNovelRegionSettings = Static<typeof UpdateNovelRegionSettingsSchema>;

// ---- Stats ----

export const NovelStatsQuerySchema = Type.Object({
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
});
export type NovelStatsQuery = Static<typeof NovelStatsQuerySchema>;

export const NovelStatsSchema = Type.Object({
  novel_id: Type.String(),
  days: Type.Integer(),
  readers: Type.Integer(),
  chapter_reads: Type.Integer(),
  completions: Type.Integer(),
  rewarded_chapters: Type.Integer(),
  coin_rewarded: Type.Integer(),
  unlocks_coin: Type.Integer(),
  unlocks_ad: Type.Integer(),
  coin_spent: Type.Integer(),
  bookshelf_count: Type.Integer(),
  chapters: Type.Array(
    Type.Object({
      chapter_no: Type.Integer(),
      title: Type.String(),
      readers: Type.Integer(),
      completions: Type.Integer(),
      unlocks: Type.Integer(),
    }),
  ),
});
export type NovelStats = Static<typeof NovelStatsSchema>;

export const TopNovelsSchema = Type.Object({
  days: Type.Integer(),
  items: Type.Array(
    Type.Object({
      novel_id: Type.String(),
      title: Type.String(),
      readers: Type.Integer(),
      completions: Type.Integer(),
      coin_rewarded: Type.Integer(),
      coin_spent: Type.Integer(),
    }),
  ),
});
