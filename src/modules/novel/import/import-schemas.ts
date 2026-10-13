import { Type, type Static } from '@sinclair/typebox';

const Uuid = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});
const NullableString = Type.Union([Type.String(), Type.Null()]);

export const ImportPreviewNovelSchema = Type.Object({
  index: Type.Integer(),
  title: Type.String(),
  author: NullableString,
  description: NullableString,
  language: NullableString,
  tags: Type.Array(Type.String()),
  cover_url: NullableString,
  cover_key: NullableString,
  chapter_count: Type.Integer(),
  word_count: Type.Integer(),
  warning_count: Type.Integer(),
});

export const ImportJobSchema = Type.Object({
  id: Type.String(),
  format: Type.String(),
  filename: Type.String(),
  mode: Type.String(),
  target_novel_id: NullableString,
  status: Type.String(),
  preview: Type.Union([Type.Object({ novels: Type.Array(ImportPreviewNovelSchema) }), Type.Null()]),
  errors: Type.Array(Type.String()),
  result_novel_ids: Type.Array(Type.String()),
  created_by: NullableString,
  created_at: Type.String(),
  finished_at: NullableString,
});
export type ImportJob = Static<typeof ImportJobSchema>;
export const ImportJobListSchema = Type.Object({ items: Type.Array(ImportJobSchema) });

export const ImportJobListQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type ImportJobListQuery = Static<typeof ImportJobListQuerySchema>;

export const ImportChaptersQuerySchema = Type.Object({
  novel_index: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
export type ImportChaptersQuery = Static<typeof ImportChaptersQuerySchema>;

export const ImportChapterPageSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      chapter_no: Type.Integer(),
      title: Type.String(),
      word_count: Type.Integer(),
      warnings: Type.Array(Type.String()),
      excerpt: Type.String(),
    }),
  ),
  next_after: Type.Union([Type.Integer(), Type.Null()]),
});
export type ImportChapterPage = Static<typeof ImportChapterPageSchema>;

export const CommitImportSchema = Type.Object({
  // Status for the imported chapters. Defaults to published: a new novel itself stays draft until
  // an editor publishes it, so nothing reaches readers by accident.
  chapter_status: Type.Optional(Type.Union([Type.Literal('draft'), Type.Literal('published')])),
  novels: Type.Optional(
    Type.Array(
      Type.Object({
        index: Type.Integer({ minimum: 0 }),
        skip: Type.Optional(Type.Boolean()),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
        author: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
        description: Type.Optional(Type.Union([Type.String({ maxLength: 20000 }), Type.Null()])),
        language: Type.Optional(Type.String({ minLength: 2, maxLength: 10 })),
        tags: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 50 }),
        ),
        status: Type.Optional(
          Type.Union([Type.Literal('draft'), Type.Literal('published'), Type.Literal('hidden')]),
        ),
        category_ids: Type.Optional(Type.Array(Uuid, { maxItems: 20 })),
      }),
      { maxItems: 500 },
    ),
  ),
});
export type CommitImportInput = Static<typeof CommitImportSchema>;
