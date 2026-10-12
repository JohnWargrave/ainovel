import { Type, type Static } from '@sinclair/typebox';

// Task definitions are read from region_config.features.tasks
export const TaskClaimBodySchema = Type.Object({
  task_id: Type.String({ minLength: 1, maxLength: 64 }),
});
export type TaskClaimBody = Static<typeof TaskClaimBodySchema>;

export const TaskItemSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.String(),
  reward_coin: Type.Number(),
  completed_today: Type.Boolean(),
  task_type: Type.Union([
    Type.Literal('watch_ad'),
    Type.Literal('invite_friend'),
    Type.Literal('share_app'),
    Type.Literal('daily_login'),
  ]),
  // Icon and destination come from region_config so they can be changed without a release; null when
  // a task predates them, which the app renders with its own bundled fallback.
  icon_url: Type.Union([Type.String(), Type.Null()]),
  // In-app destination for the task's CTA, e.g. "ainovel://spin". Not an HTTP URL — the backend
  // never sends the app somewhere outside itself for a task.
  action: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([Type.Literal('available'), Type.Literal('completed')]),
  // Every task today is a single-shot daily claim, so progress is 0 or 1 against a target of 1.
  // Present so the app can render one progress component for all tasks, and so multi-step tasks can
  // arrive later without a breaking response change.
  progress: Type.Number(),
  target: Type.Number(),
});

export const TaskListResponseSchema = Type.Object({
  tasks: Type.Array(TaskItemSchema),
  reset_at: Type.String(), // ISO UTC midnight
});
export type TaskListResponse = Static<typeof TaskListResponseSchema>;

export const TaskClaimResponseSchema = Type.Object({
  task_id: Type.String(),
  credited_coin: Type.Number(),
  new_balance: Type.String(),
});
export type TaskClaimResponse = Static<typeof TaskClaimResponseSchema>;
