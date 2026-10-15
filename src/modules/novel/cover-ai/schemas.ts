import { Type, type Static } from '@sinclair/typebox';

export const CreateCoverJobSchema = Type.Object(
  {
    // The admin's own image prompt (English works best). Omitted: the LLM writes one from the novel.
    prompt: Type.Optional(Type.String({ minLength: 10, maxLength: 2000 })),
  },
  { additionalProperties: false },
);
export type CreateCoverJobInput = Static<typeof CreateCoverJobSchema>;

const CoverBriefSchema = Type.Object({
  subject: Type.String(),
  setting: Type.String(),
  mood: Type.String(),
  palette: Type.String(),
  style: Type.String(),
  composition: Type.String(),
  prompt: Type.String(),
});

export const CoverCandidateSchema = Type.Object({
  id: Type.String(),
  idx: Type.Integer(),
  url: Type.String(),
  clean_url: Type.String(),
  applied_at: Type.Union([Type.String(), Type.Null()]),
});

export const CoverJobSchema = Type.Object({
  id: Type.String(),
  novel_id: Type.String(),
  status: Type.String(),
  trigger: Type.String(),
  prompt: Type.Union([Type.String(), Type.Null()]),
  brief: Type.Union([CoverBriefSchema, Type.Null()]),
  model: Type.Union([Type.String(), Type.Null()]),
  errors: Type.Array(Type.String()),
  created_at: Type.String(),
  finished_at: Type.Union([Type.String(), Type.Null()]),
  candidates: Type.Array(CoverCandidateSchema),
});

export const LatestCoverJobSchema = Type.Object({
  job: Type.Union([CoverJobSchema, Type.Null()]),
});
