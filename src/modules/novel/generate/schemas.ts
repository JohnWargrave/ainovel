import { Type, type Static } from '@sinclair/typebox';
import { LIMITS } from './plan.js';

const Uuid = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});
const Note = Type.String({ maxLength: 2000 });

export const GenIdParamsSchema = Type.Object({ id: Uuid });
export const GenChapterParamsSchema = Type.Object({
  id: Uuid,
  no: Type.Integer({ minimum: 1, maximum: LIMITS.chapters }),
});
export type GenChapterParams = Static<typeof GenChapterParamsSchema>;

export const CreateGenProjectSchema = Type.Object(
  {
    idea: Type.String({ minLength: 10, maxLength: LIMITS.idea }),
    title: Type.Optional(Type.String({ maxLength: LIMITS.title })),
    category_ids: Type.Optional(Type.Array(Uuid, { maxItems: 10 })),
    language: Type.Optional(Type.String({ minLength: 2, maxLength: 10 })),
    tone: Type.Optional(Type.String({ maxLength: LIMITS.short })),
    audience: Type.Optional(Type.String({ maxLength: LIMITS.short })),
    chapter_count: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.chapters })),
    words_per_chapter: Type.Optional(Type.Integer({ minimum: 300, maximum: 5000 })),
    auto_cover: Type.Optional(Type.Boolean()),
    // An id from the AI settings' model list; omitted = the default novel model.
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);
export type CreateGenProjectInput = Static<typeof CreateGenProjectSchema>;

export const RegenerateSchema = Type.Object(
  { note: Type.Optional(Note) },
  { additionalProperties: false },
);
export type RegenerateInput = Static<typeof RegenerateSchema>;

export const GenerateOutlineSchema = Type.Object(
  {
    note: Type.Optional(Note),
    chapter_count: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.chapters })),
  },
  { additionalProperties: false },
);
export type GenerateOutlineInput = Static<typeof GenerateOutlineSchema>;

export const StartWritingSchema = Type.Object(
  {
    from: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.chapters })),
    to: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.chapters })),
    overwrite: Type.Optional(Type.Boolean()),
    words_per_chapter: Type.Optional(Type.Integer({ minimum: 300, maximum: 5000 })),
    // Switches the project's model from this run on.
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);
export type StartWritingInput = Static<typeof StartWritingSchema>;

const CharacterSchema = Type.Object({
  name: Type.String({ maxLength: LIMITS.listItem }),
  role: Type.String({ maxLength: LIMITS.listItem }),
  description: Type.String({ maxLength: LIMITS.text }),
  goal: Type.String({ maxLength: LIMITS.short }),
  relationships: Type.String({ maxLength: LIMITS.short }),
});

const StringList = Type.Array(Type.String({ maxLength: LIMITS.listItem }), {
  maxItems: LIMITS.listItems,
});

export const StoryBibleSchema = Type.Object({
  title: Type.String({ maxLength: LIMITS.title }),
  logline: Type.String({ maxLength: LIMITS.short }),
  description: Type.String({ maxLength: LIMITS.text }),
  setting: Type.String({ maxLength: LIMITS.text }),
  world_rules: Type.String({ maxLength: LIMITS.text }),
  tone: Type.String({ maxLength: LIMITS.short }),
  themes: StringList,
  tags: StringList,
  characters: Type.Array(CharacterSchema, { maxItems: LIMITS.characters }),
});

const ArcSchema = Type.Object({
  title: Type.String({ maxLength: LIMITS.title }),
  summary: Type.String({ maxLength: LIMITS.text }),
  from_chapter: Type.Integer(),
  to_chapter: Type.Integer(),
});

const OutlineChapterSchema = Type.Object({
  no: Type.Integer(),
  title: Type.String({ maxLength: LIMITS.title }),
  beats: Type.Array(Type.String({ maxLength: LIMITS.beat }), { maxItems: LIMITS.beats }),
  locked: Type.Boolean(),
});

export const StoryOutlineSchema = Type.Object({
  arcs: Type.Array(ArcSchema, { maxItems: LIMITS.arcs }),
  chapters: Type.Array(OutlineChapterSchema, { maxItems: LIMITS.chapters }),
});

export const UpdateBibleSchema = Type.Object(
  { bible: StoryBibleSchema },
  { additionalProperties: false },
);
export type UpdateBibleInput = Static<typeof UpdateBibleSchema>;
export const UpdateOutlineSchema = Type.Object(
  { outline: StoryOutlineSchema },
  { additionalProperties: false },
);
export type UpdateOutlineInput = Static<typeof UpdateOutlineSchema>;

const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableInteger = Type.Union([Type.Integer(), Type.Null()]);

const SummaryFields = {
  id: Type.String(),
  title: Type.String(),
  status: Type.String(),
  task: Type.String(),
  busy: Type.Boolean(),
  novel_id: NullableString,
  progress: NullableString,
  planned_chapters: Type.Integer(),
  created_at: Type.String(),
  updated_at: Type.String(),
};

export const GenProjectListSchema = Type.Object({
  items: Type.Array(Type.Object(SummaryFields)),
});

export const GenProjectSchema = Type.Object({
  ...SummaryFields,
  input: Type.Object({
    idea: Type.String(),
    title: Type.String(),
    category_ids: Type.Array(Type.String()),
    genres: Type.Array(Type.String()),
    language: Type.String(),
    tone: Type.String(),
    audience: Type.String(),
    chapter_count: Type.Integer(),
    words_per_chapter: Type.Integer(),
    auto_cover: Type.Boolean(),
  }),
  bible: Type.Union([StoryBibleSchema, Type.Null()]),
  outline: Type.Union([StoryOutlineSchema, Type.Null()]),
  task_note: NullableString,
  task_chapter_no: NullableInteger,
  write_from: NullableInteger,
  write_to: NullableInteger,
  write_next: NullableInteger,
  write_overwrite: Type.Boolean(),
  live_chapter_no: NullableInteger,
  live_text: NullableString,
  model: NullableString,
  prompt_tokens: Type.Integer(),
  completion_tokens: Type.Integer(),
  cost_usd: Type.Number(),
  errors: Type.Array(Type.String()),
  written: Type.Array(
    Type.Object({
      chapter_no: Type.Integer(),
      id: Type.String(),
      status: Type.String(),
      word_count: Type.Integer(),
    }),
  ),
});

export const DeletedSchema = Type.Object({ deleted: Type.Boolean() });
