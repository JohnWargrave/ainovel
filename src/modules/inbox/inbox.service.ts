import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import type { InboxListQuery, InboxListResponse, InboxMessage } from './schemas.js';

const DEFAULT_LIMIT = 20;

interface InboxRow {
  id: string;
  type: string;
  title: string;
  body: string;
  payload: unknown;
  read_at: Date | null;
  created_at: Date;
}

// 06-REDEMPTION-FULFILLMENT.md §4: the inbox message only announces that a reward is ready. The
// delivery code itself stays out of `payload` and is only ever served by
// `GET /redemptions/{id}/code`, which decrypts, rate-limits and logs the access. Anything writing an
// inbox row (currently only redemption.service.ts pasteDeliveryCode) must keep it that way — this
// endpoint returns `payload` verbatim.
function serialize(row: InboxRow): InboxMessage {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    payload: row.payload ?? {},
    read_at: row.read_at ? new Date(row.read_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
  };
}

export async function listInbox(userId: string, query: InboxListQuery): Promise<InboxListResponse> {
  const limit = query.limit ?? DEFAULT_LIMIT;

  let builder = db
    .selectFrom('inbox_messages')
    .select(['id', 'type', 'title', 'body', 'payload', 'read_at', 'created_at'])
    .where('user_id', '=', userId)
    // uuidv7 ids are time-sortable, so id ordering doubles as newest-first — same cursor scheme as
    // GET /wallet/ledger, no compound (created_at, id) cursor needed.
    .orderBy('id', 'desc')
    .limit(limit + 1);
  if (query.cursor) {
    builder = builder.where('id', '<', query.cursor);
  }

  const [rows, unread] = await Promise.all([
    builder.execute(),
    db
      .selectFrom('inbox_messages')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('user_id', '=', userId)
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow(),
  ]);

  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => serialize(row)),
    next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    unread_count: Number(unread.count),
  };
}

// 404 rather than 403 on someone else's message: a 403 would confirm the id exists, which turns the
// endpoint into an existence oracle over other users' inboxes.
async function loadOwnedMessage(userId: string, messageId: string): Promise<InboxRow> {
  const row = await db
    .selectFrom('inbox_messages')
    .select(['id', 'type', 'title', 'body', 'payload', 'read_at', 'created_at'])
    .where('id', '=', messageId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError('NOT_FOUND', 'Message not found', 404);
  }
  return row;
}

export async function getInboxMessage(userId: string, messageId: string): Promise<InboxMessage> {
  return serialize(await loadOwnedMessage(userId, messageId));
}

// Idempotent: re-reading an already-read message keeps the original `read_at` instead of bumping it,
// so "when did the user first see this" stays answerable.
export async function markInboxMessageRead(
  userId: string,
  messageId: string,
): Promise<InboxMessage> {
  const row = await loadOwnedMessage(userId, messageId);
  if (row.read_at) {
    return serialize(row);
  }

  const readAt = new Date();
  await db
    .updateTable('inbox_messages')
    .set({ read_at: readAt })
    .where('id', '=', messageId)
    .where('user_id', '=', userId)
    .where('read_at', 'is', null)
    .execute();

  return serialize({ ...row, read_at: readAt });
}
