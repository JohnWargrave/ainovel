import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import type {
  AdminReport,
  AdminReportListQuery,
  AdminReportListResponse,
  AdminReportUpdateBody,
  ReportBody,
  ReportResponse,
} from './schemas.js';

const DEFAULT_PAGE_SIZE = 50;

// A report must point at something that exists; a reader cannot see a deleted novel to report it,
// so a miss is a bad id rather than a race worth tolerating.
async function assertTargetExists(
  targetType: 'novel' | 'chapter',
  targetId: string,
): Promise<void> {
  const row =
    targetType === 'novel'
      ? await db.selectFrom('novels').select('id').where('id', '=', targetId).executeTakeFirst()
      : await db
          .selectFrom('novel_chapters')
          .select('id')
          .where('id', '=', targetId)
          .executeTakeFirst();
  if (!row) throw new AppError('REPORT_TARGET_NOT_FOUND', 'Reported content not found', 404);
}

export async function submitReport(userId: string, body: ReportBody): Promise<ReportResponse> {
  let targetId: string | null = null;
  if (body.target_type !== 'app') {
    if (!body.target_id) {
      throw new AppError('VALIDATION_ERROR', 'target_id is required for this target_type', 400);
    }
    await assertTargetExists(body.target_type, body.target_id);
    targetId = body.target_id;
  }
  const message = body.message?.trim();
  const row = await db
    .insertInto('content_reports')
    .values({
      id: uuidv7(),
      user_id: userId,
      target_type: body.target_type,
      target_id: targetId,
      reason: body.reason,
      message: message === undefined || message === '' ? null : message,
    })
    .returning(['id', 'status', 'created_at'])
    .executeTakeFirstOrThrow();
  return { id: row.id, status: row.status, created_at: row.created_at.toISOString() };
}

interface ReportFilter {
  id?: string;
  status?: AdminReportListQuery['status'];
  targetType?: AdminReportListQuery['target_type'];
  before?: string;
  limit: number;
}

// Reports with their target named: the novel title, or "Novel · Chapter" for chapter reports.
async function fetchReports(filter: ReportFilter): Promise<AdminReport[]> {
  let builder = db
    .selectFrom('content_reports as report')
    .innerJoin('users', 'users.id', 'report.user_id')
    .leftJoin('novel_chapters as chapter', (join) =>
      join.onRef('chapter.id', '=', 'report.target_id').on('report.target_type', '=', 'chapter'),
    )
    .leftJoin('novels as novel', (join) =>
      join.on((eb) =>
        eb.or([
          eb.and([
            eb('report.target_type', '=', 'novel'),
            eb('novel.id', '=', eb.ref('report.target_id')),
          ]),
          eb('novel.id', '=', eb.ref('chapter.novel_id')),
        ]),
      ),
    )
    .select([
      'report.id',
      'report.user_id',
      'users.public_id',
      'report.target_type',
      'report.target_id',
      'novel.id as novel_id',
      sql<string | null>`CASE
        WHEN report.target_type = 'chapter' THEN novel.title || ' · ' || chapter.title
        ELSE novel.title
      END`.as('target_title'),
      'report.reason',
      'report.message',
      'report.status',
      'report.resolved_by',
      'report.resolved_at',
      'report.created_at',
    ])
    .orderBy('report.id', 'desc')
    .limit(filter.limit);
  if (filter.id) builder = builder.where('report.id', '=', filter.id);
  if (filter.status) builder = builder.where('report.status', '=', filter.status);
  if (filter.targetType) builder = builder.where('report.target_type', '=', filter.targetType);
  // uuidv7 ids sort by time, so the id doubles as the cursor.
  if (filter.before) builder = builder.where('report.id', '<', filter.before);
  const rows = await builder.execute();
  return rows.map((row) => ({
    ...row,
    novel_id: row.novel_id ?? null,
    resolved_at: row.resolved_at ? row.resolved_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  }));
}

export async function listReports(query: AdminReportListQuery): Promise<AdminReportListResponse> {
  const limit = query.limit ?? DEFAULT_PAGE_SIZE;
  const rows = await fetchReports({
    ...(query.status ? { status: query.status } : {}),
    ...(query.target_type ? { targetType: query.target_type } : {}),
    ...(query.cursor ? { before: query.cursor } : {}),
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  return {
    items: page,
    next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function updateReportStatus(
  reportId: string,
  adminUserId: string,
  body: AdminReportUpdateBody,
): Promise<AdminReport> {
  await db.transaction().execute(async (trx) => {
    const report = await trx
      .selectFrom('content_reports')
      .select('status')
      .where('id', '=', reportId)
      .forUpdate()
      .executeTakeFirst();
    if (!report) throw new AppError('REPORT_NOT_FOUND', 'Report not found', 404);
    const closing = body.status !== 'open';
    await trx
      .updateTable('content_reports')
      .set({
        status: body.status,
        // Reopening clears who closed it, so the open queue never shows a stale resolver.
        resolved_by: closing ? adminUserId : null,
        resolved_at: closing ? new Date() : null,
      })
      .where('id', '=', reportId)
      .execute();
    await trx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: adminUserId,
        action: 'CONTENT_REPORT_STATUS_CHANGED',
        target_type: 'content_report',
        target_id: reportId,
        detail: JSON.stringify({ from: report.status, to: body.status, note: body.note ?? null }),
        ip: null,
      })
      .execute();
  });
  const [report] = await fetchReports({ id: reportId, limit: 1 });
  if (!report) throw new AppError('REPORT_NOT_FOUND', 'Report not found', 404);
  return report;
}
