import { Type, type Static } from '@sinclair/typebox';

// `id` is a UUID column, so a malformed cursor would reach Postgres as an invalid uuid literal and
// surface as a 500. The pattern turns that into a 400 at the edge.
const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export const InboxListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type InboxListQuery = Static<typeof InboxListQuerySchema>;

export const InboxMessageSchema = Type.Object({
  id: Type.String(),
  type: Type.String(),
  title: Type.String(),
  body: Type.String(),
  // Free-form per message type. Never carries a delivery code — see inbox.service.ts.
  payload: Type.Unknown(),
  read_at: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
});
export type InboxMessage = Static<typeof InboxMessageSchema>;

export const InboxListResponseSchema = Type.Object({
  items: Type.Array(InboxMessageSchema),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
  // Returned with the list so the unread badge does not need a second round trip.
  unread_count: Type.Integer(),
});
export type InboxListResponse = Static<typeof InboxListResponseSchema>;

export const InboxMessageParamsSchema = Type.Object({ id: Type.String({ pattern: UUID_PATTERN }) });
export interface InboxMessageParams {
  id: string;
}
