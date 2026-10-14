import { uuidv7 } from 'uuidv7';
import { db } from '../../db/index.js';
import type {
  AdminFeedbackListQuery,
  AdminFeedbackListResponse,
  FeedbackBody,
  FeedbackResponse,
} from './schemas.js';

const DEFAULT_PAGE_SIZE = 50;

export async function submitFeedback(
  userId: string,
  body: FeedbackBody,
  appVersion: string | undefined,
): Promise<FeedbackResponse> {
  const message = body.message?.trim();
  const row = await db
    .insertInto('app_feedback')
    .values({
      id: uuidv7(),
      user_id: userId,
      rating: body.rating,
      // A message of only whitespace is no message.
      message: message === undefined || message === '' ? null : message,
      email: body.email ?? null,
      app_version: appVersion ?? null,
    })
    .returning(['id', 'created_at'])
    .executeTakeFirstOrThrow();
  return { id: row.id, created_at: row.created_at.toISOString() };
}

export async function listFeedback(
  query: AdminFeedbackListQuery,
): Promise<AdminFeedbackListResponse> {
  const limit = query.limit ?? DEFAULT_PAGE_SIZE;
  let builder = db
    .selectFrom('app_feedback')
    .innerJoin('users', 'users.id', 'app_feedback.user_id')
    .select([
      'app_feedback.id',
      'app_feedback.user_id',
      'users.public_id',
      'app_feedback.rating',
      'app_feedback.message',
      'app_feedback.email',
      'app_feedback.app_version',
      'app_feedback.created_at',
    ])
    .orderBy('app_feedback.id', 'desc')
    .limit(limit + 1);
  if (query.rating !== undefined) builder = builder.where('app_feedback.rating', '=', query.rating);
  // uuidv7 ids sort by time, so the id doubles as the cursor.
  if (query.cursor) builder = builder.where('app_feedback.id', '<', query.cursor);
  const rows = await builder.execute();
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({ ...row, created_at: row.created_at.toISOString() })),
    next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}
