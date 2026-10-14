import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { dayKey, dayWindow } from '../../lib/day-window.js';
import { creditInTransaction } from '../wallet-ledger/ledger.service.js';
import { loadUserRegionFeatures, readFeature } from './region-features.js';
import type { TaskListResponse, TaskClaimResponse } from './tasks-schemas.js';

// Tasks whose progress the server measures itself. They pay only once progress reaches the target;
// every other type is a self-asserted single-shot claim.
const PROGRESS_TASK_TYPES = ['read_minutes', 'finish_chapters', 'watch_videos'] as const;
type ProgressTaskType = (typeof PROGRESS_TASK_TYPES)[number];

interface TaskConfig {
  id: string;
  title: string;
  description: string;
  reward_coin: number;
  task_type: 'watch_ad' | 'invite_friend' | 'share_app' | 'daily_login' | ProgressTaskType;
  // Progress tasks only: minutes for read_minutes, a count for the others. Defaults to 1.
  target?: number;
  icon_url?: string | null;
  action?: string | null;
}

type DailyProgress = Record<ProgressTaskType, number>;

function isProgressTask(task: TaskConfig): task is TaskConfig & { task_type: ProgressTaskType } {
  return (PROGRESS_TASK_TYPES as readonly string[]).includes(task.task_type);
}

function targetOf(task: TaskConfig): number {
  if (!isProgressTask(task)) return 1;
  return typeof task.target === 'number' && Number.isInteger(task.target) && task.target > 0
    ? task.target
    : 1;
}

// Today's server-measured totals, in the region-local day the tasks reset on.
async function dailyProgress(userId: string, timezone: string, now: Date): Promise<DailyProgress> {
  const window = dayWindow(timezone, now);
  const [reading, ads] = await Promise.all([
    db
      .selectFrom('novel_read_daily')
      .select(['read_seconds', 'chapters_completed'])
      .where('user_id', '=', userId)
      .where('day', '=', dayKey(timezone, now))
      .executeTakeFirst(),
    // Any placement: the task is "watch N videos", and every consumed intent is an SSV-verified view.
    db
      .selectFrom('rewarded_ad_intents')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where('user_id', '=', userId)
      .where('status', '=', 'consumed')
      .where('consumed_at', '>=', window.start)
      .where('consumed_at', '<', window.end)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    read_minutes: Math.floor((reading?.read_seconds ?? 0) / 60),
    finish_chapters: reading?.chapters_completed ?? 0,
    watch_videos: Number(ads.total),
  };
}

interface TasksFeature {
  enabled: boolean;
  list: TaskConfig[];
}

interface ResolvedTasks {
  timezone: string;
  list: TaskConfig[];
}

// Claims here are self-asserted — the client says "I did it" and we pay. That is acceptable only
// for tasks whose reward is not also credited by a verified path, and only under the unbacked
// rolling cap (ledger.service.ts). `watch_ad` is excluded at the config level: ad views are paid by
// the AdMob SSV callback, so accepting a manual claim would pay the same view twice.
//
// There is deliberately no hardcoded task list here. Reward amounts are money; a fallback list in
// code would keep minting coin in any region whose config is missing or half-migrated.
async function resolveTasks(userId: string): Promise<ResolvedTasks> {
  const { timezone, features } = await loadUserRegionFeatures(userId);
  const feature = readFeature<TasksFeature>(features, 'tasks');
  // Fail closed: an absent `tasks` key means the module was never configured for this region, which
  // must read as "off", not as "on with defaults". `watch_videos` is unaffected by the watch_ad
  // exclusion below: it pays a bonus for N SSV-verified views, not for one self-reported view.
  if (!feature.enabled) {
    throw new AppError('FEATURE_DISABLED', 'Daily tasks are not available', 404);
  }
  const list = Array.isArray(feature.list) ? feature.list : [];
  return { timezone, list: list.filter((task) => task.task_type !== 'watch_ad') };
}

function idempotencyKeyFor(taskId: string, userId: string, timezone: string, now: Date): string {
  return `task:${taskId}:${userId}:${dayKey(timezone, now)}`;
}

export async function listTasks(userId: string): Promise<TaskListResponse> {
  const { timezone, list } = await resolveTasks(userId);
  const now = new Date();
  const window = dayWindow(timezone, now);

  // Completion is looked up by idempotency key, not by ref_id: coin_ledger.ref_id is a UUID column
  // (migration 5) and a task id is a config string, so it cannot be stored there. The key already
  // encodes (task, user, region-local day) and is uniquely indexed, so this is one index probe.
  const keyToTaskId = new Map(
    list.map((task) => [idempotencyKeyFor(task.id, userId, timezone, now), task.id] as const),
  );
  const claimedRows =
    keyToTaskId.size > 0
      ? await db
          .selectFrom('coin_ledger')
          .select(['idempotency_key'])
          .where('idempotency_key', 'in', [...keyToTaskId.keys()])
          .execute()
      : [];

  const completedIds = new Set(
    claimedRows.map((row) => keyToTaskId.get(row.idempotency_key ?? '')),
  );
  const measured = list.some(isProgressTask) ? await dailyProgress(userId, timezone, now) : null;

  return {
    // Built field by field rather than spreading `task`: the config object is admin-editable JSON,
    // and spreading it would leak any extra key an admin adds straight into the public response.
    tasks: list.map((task) => {
      const completed = completedIds.has(task.id);
      const target = targetOf(task);
      const progress =
        isProgressTask(task) && measured
          ? Math.min(measured[task.task_type], target)
          : completed
            ? 1
            : 0;
      const status = completed
        ? ('completed' as const)
        : isProgressTask(task) && progress < target
          ? ('in_progress' as const)
          : ('available' as const);
      return {
        id: task.id,
        title: task.title,
        description: task.description,
        reward_coin: task.reward_coin,
        task_type: task.task_type,
        icon_url: task.icon_url ?? null,
        action: task.action ?? null,
        completed_today: completed,
        status,
        progress,
        target,
      };
    }),
    reset_at: window.end.toISOString(),
  };
}

export async function claimTask(userId: string, taskId: string): Promise<TaskClaimResponse> {
  const { timezone, list } = await resolveTasks(userId);
  const task = list.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new AppError('NOT_FOUND', 'Task not found', 404);
  }
  const now = new Date();
  if (isProgressTask(task)) {
    // Checked before the credit and outside its transaction: progress only ever grows within a day,
    // so a stale read can only under-report, never let an unfinished task through.
    const measured = await dailyProgress(userId, timezone, now);
    if (measured[task.task_type] < targetOf(task)) {
      throw new AppError('TASK_NOT_COMPLETE', 'Task progress has not reached its target', 409);
    }
  }

  const result = await db.transaction().execute(async (trx) =>
    creditInTransaction(trx, {
      userId,
      entryType: 'TASK_CREDIT',
      amount: task.reward_coin,
      bucket: 'available',
      // No refId: the column is a UUID soft-FK to a source row, and a task id is a config string.
      refType: 'task',
      idempotencyKey: idempotencyKeyFor(task.id, userId, timezone, now),
      note: `Completed task: ${task.title}`,
    }),
  );

  if (result.deduped) {
    throw new AppError('ALREADY_CLAIMED', 'Task already completed today', 409);
  }

  return {
    task_id: task.id,
    credited_coin: task.reward_coin,
    new_balance: result.balanceAfter,
  };
}
