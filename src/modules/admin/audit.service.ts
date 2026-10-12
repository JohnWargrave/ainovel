import { db } from '../../db/index.js';
import type { AuditLogEntry, AuditLogListQuery, AuditLogListResponse } from './schemas.js';

const DEFAULT_AUDIT_LIMIT = 50;

interface AuditLogRow {
  id: string;
  admin_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: unknown;
  ip: string | null;
  created_at: Date;
}

function parseDetail(detail: unknown): unknown {
  if (typeof detail !== 'string') return detail ?? {};
  try {
    return JSON.parse(detail) as unknown;
  } catch {
    return detail;
  }
}

function serializeAuditLog(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    admin_user_id: row.admin_user_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    detail: parseDetail(row.detail),
    ip: row.ip,
    created_at: row.created_at.toISOString(),
  };
}

export async function listAuditLog(query: AuditLogListQuery): Promise<AuditLogListResponse> {
  const limit = query.limit ?? DEFAULT_AUDIT_LIMIT;
  let builder = db.selectFrom('audit_log').selectAll().orderBy('id', 'desc').limit(limit + 1);

  if (query.actor_id) builder = builder.where('admin_user_id', '=', query.actor_id);
  if (query.action) builder = builder.where('action', '=', query.action);
  if (query.target_type) builder = builder.where('target_type', '=', query.target_type);
  if (query.target_id) builder = builder.where('target_id', '=', query.target_id);
  if (query.cursor) builder = builder.where('id', '<', query.cursor);

  const rows = await builder.execute();
  const page = rows.slice(0, limit);
  return {
    items: page.map(serializeAuditLog),
    next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}
