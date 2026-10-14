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

export const ReportTargetTypeSchema = Type.Union([
  Type.Literal('novel'),
  Type.Literal('chapter'),
  Type.Literal('app'),
]);
export const ReportReasonSchema = Type.Union([
  Type.Literal('inappropriate'),
  Type.Literal('copyright'),
  Type.Literal('wrong_content'),
  Type.Literal('spam'),
  Type.Literal('other'),
]);
export const ReportStatusSchema = Type.Union([
  Type.Literal('open'),
  Type.Literal('resolved'),
  Type.Literal('dismissed'),
]);

export const ReportBodySchema = Type.Object({
  target_type: ReportTargetTypeSchema,
  // The novel or chapter id (the chapter's UUID, as in the table of contents). Ignored for 'app'.
  target_id: Type.Optional(Type.String({ format: 'uuid' })),
  reason: ReportReasonSchema,
  message: Type.Optional(Type.String({ maxLength: 2000 })),
});
export type ReportBody = Static<typeof ReportBodySchema>;

export const ReportResponseSchema = Type.Object({
  id: Type.String(),
  status: ReportStatusSchema,
  created_at: Type.String(),
});
export type ReportResponse = Static<typeof ReportResponseSchema>;

export const AdminReportListQuerySchema = Type.Object({
  status: Type.Optional(ReportStatusSchema),
  target_type: Type.Optional(ReportTargetTypeSchema),
  cursor: Type.Optional(Type.String({ format: 'uuid' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type AdminReportListQuery = Static<typeof AdminReportListQuerySchema>;

export const AdminReportSchema = Type.Object({
  id: Type.String(),
  user_id: Type.String(),
  public_id: Type.String(),
  target_type: ReportTargetTypeSchema,
  target_id: Type.Union([Type.Null(), Type.String()]),
  // What the target is called now: the novel title, or "Novel title · Chapter title".
  target_title: Type.Union([Type.Null(), Type.String()]),
  // The novel to open in the CMS for novel and chapter reports.
  novel_id: Type.Union([Type.Null(), Type.String()]),
  reason: ReportReasonSchema,
  message: Type.Union([Type.Null(), Type.String()]),
  status: ReportStatusSchema,
  resolved_by: Type.Union([Type.Null(), Type.String()]),
  resolved_at: Type.Union([Type.Null(), Type.String()]),
  created_at: Type.String(),
});
export type AdminReport = Static<typeof AdminReportSchema>;

export const AdminReportListResponseSchema = Type.Object({
  items: Type.Array(AdminReportSchema),
  next_cursor: Type.Union([Type.Null(), Type.String()]),
});
export type AdminReportListResponse = Static<typeof AdminReportListResponseSchema>;

export const AdminReportParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) });
export type AdminReportParams = Static<typeof AdminReportParamsSchema>;

export const AdminReportUpdateBodySchema = Type.Object({
  status: ReportStatusSchema,
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});
export type AdminReportUpdateBody = Static<typeof AdminReportUpdateBodySchema>;
