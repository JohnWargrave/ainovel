import { Type, type Static } from '@sinclair/typebox';

export const FeedbackBodySchema = Type.Object({
  rating: Type.Integer({ minimum: 1, maximum: 5 }),
  message: Type.Optional(Type.String({ maxLength: 2000 })),
  // Where the team can reply, when the reader wants an answer.
  email: Type.Optional(
    Type.String({ minLength: 3, maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' }),
  ),
});
export type FeedbackBody = Static<typeof FeedbackBodySchema>;

export const FeedbackResponseSchema = Type.Object({
  id: Type.String(),
  created_at: Type.String(),
});
export type FeedbackResponse = Static<typeof FeedbackResponseSchema>;

export const AdminFeedbackListQuerySchema = Type.Object({
  rating: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  cursor: Type.Optional(Type.String({ format: 'uuid' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type AdminFeedbackListQuery = Static<typeof AdminFeedbackListQuerySchema>;

export const AdminFeedbackSchema = Type.Object({
  id: Type.String(),
  user_id: Type.String(),
  public_id: Type.String(),
  rating: Type.Integer(),
  message: Type.Union([Type.Null(), Type.String()]),
  email: Type.Union([Type.Null(), Type.String()]),
  app_version: Type.Union([Type.Null(), Type.String()]),
  created_at: Type.String(),
});
export type AdminFeedback = Static<typeof AdminFeedbackSchema>;

export const AdminFeedbackListResponseSchema = Type.Object({
  items: Type.Array(AdminFeedbackSchema),
  next_cursor: Type.Union([Type.Null(), Type.String()]),
});
export type AdminFeedbackListResponse = Static<typeof AdminFeedbackListResponseSchema>;
