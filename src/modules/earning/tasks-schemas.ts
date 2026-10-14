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
    // Server-measured progress tasks: claimable only once progress reaches target.
    Type.Literal('read_minutes'),
    Type.Literal('finish_chapters'),
    Type.Literal('watch_videos'),
  ]),
  // Icon and destination come from region_config so they can be changed without a release; null when
  // a task predates them, which the app renders with its own bundled fallback.
  icon_url: Type.Union([Type.String(), Type.Null()]),
  // In-app destination for the task's CTA, e.g. "ainovel://spin". Not an HTTP URL — the backend
  // never sends the app somewhere outside itself for a task.
  action: Type.Union([Type.String(), Type.Null()]),
  // in_progress: a progress task still short of its target (not claimable yet).
  status: Type.Union([
    Type.Literal('available'),
    Type.Literal('in_progress'),
    Type.Literal('completed'),
  ]),
  // Progress tasks report today's measured value (capped at target): minutes read, chapters
  // finished, or verified ad views. Single-shot tasks are 0 or 1 against a target of 1.
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
