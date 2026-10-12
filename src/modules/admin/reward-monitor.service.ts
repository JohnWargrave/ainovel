import { sql, type RawBuilder } from 'kysely';
import { db } from '../../db/index.js';
import type {
  RewardMonitorNetwork,
  RewardMonitorQuery,
  RewardMonitorResponse,
} from './reward-monitor.schemas.js';

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_REWARD_LIMIT = 50;
const RECENT_CALLBACK_LIMIT = 20;

function callbackUserId(network: RewardMonitorNetwork): RawBuilder<string | null> {
  return network === 'tapjoy'
    ? sql<string | null>`postback_logs.query_params ->> 'snuid'`
    : sql<string | null>`postback_logs.query_params ->> 'user_id'`;
}

function callbackTransactionId(network: RewardMonitorNetwork): RawBuilder<string | null> {
  return network === 'tapjoy'
    ? sql<string | null>`postback_logs.query_params ->> 'id'`
    : sql<string | null>`postback_logs.query_params ->> 'token'`;
}

export async function getRewardMonitor(
  network: RewardMonitorNetwork,
  query: RewardMonitorQuery,
): Promise<RewardMonitorResponse> {
  const to = new Date();
  const from = new Date(
    to.getTime() - (query.window_hours ?? DEFAULT_WINDOW_HOURS) * 60 * 60 * 1000,
  );
  const limit = query.limit ?? DEFAULT_REWARD_LIMIT;

  let rewardBase = db
    .selectFrom('earning_events')
    .innerJoin('coin_ledger', (join) =>
      join
        .onRef('coin_ledger.ref_id', '=', 'earning_events.id')
        .on('coin_ledger.ref_type', '=', 'earning_event')
        .on('coin_ledger.entry_type', '=', 'OFFERWALL_CREDIT'),
    )
    .where('earning_events.source', '=', network)
    .where('earning_events.created_at', '>=', from)
    .where('earning_events.created_at', '<=', to);
  if (query.user_id) {
    rewardBase = rewardBase.where('earning_events.user_id', '=', query.user_id);
  }
  if (query.transaction_id) {
    rewardBase = rewardBase.where('earning_events.network_tx_id', '=', query.transaction_id);
  }

  let rewardsQuery = rewardBase
    .select([
      'earning_events.id as id',
      'earning_events.created_at as created_at',
      'earning_events.user_id as user_id',
      'earning_events.network_tx_id as transaction_id',
      'earning_events.payout_usd as payout_usd',
      'earning_events.coin_awarded as coins_awarded',
      'earning_events.share_applied as share_applied',
      'earning_events.status as status',
      'coin_ledger.bucket as bucket',
      'coin_ledger.balance_after as available_balance_after',
      'coin_ledger.hold_until as hold_until',
    ])
    .orderBy('earning_events.id', 'desc')
    .limit(limit + 1);
  if (query.cursor) {
    rewardsQuery = rewardsQuery.where('earning_events.id', '<', query.cursor);
  }

  const rewardSummaryQuery = rewardBase.select([
    sql<string>`count(*)`.as('rewards_credited'),
    sql<string>`coalesce(sum(coin_ledger.amount), 0)`.as('coins_credited'),
    sql<string>`count(distinct earning_events.user_id)`.as('unique_users'),
    sql<Date | null>`max(earning_events.created_at)`.as('latest_credit_at'),
  ]);

  let callbackBase = db
    .selectFrom('postback_logs')
    .where('postback_logs.network', '=', network)
    .where('postback_logs.created_at', '>=', from)
    .where('postback_logs.created_at', '<=', to);
  if (query.user_id) {
    callbackBase = callbackBase.where(callbackUserId(network), '=', query.user_id);
  }
  if (query.transaction_id) {
    callbackBase = callbackBase.where(callbackTransactionId(network), '=', query.transaction_id);
  }

  const callbackSummaryQuery = callbackBase.select([
    sql<string>`count(*)`.as('callbacks_received'),
    sql<string>`count(*) filter (
      where postback_logs.verdict <> 'duplicate'
        and postback_logs.earning_event_id is null
    )`.as('callbacks_not_credited'),
  ]);

  const callbacksQuery = callbackBase
    .select([
      'postback_logs.id as id',
      'postback_logs.created_at as created_at',
      'postback_logs.verdict as verdict',
      callbackUserId(network).as('user_id'),
      callbackTransactionId(network).as('transaction_id'),
      'postback_logs.earning_event_id as earning_event_id',
    ])
    .orderBy('postback_logs.id', 'desc')
    .limit(RECENT_CALLBACK_LIMIT);

  const [rewardRows, rewardSummary, callbackSummary, callbackRows] = await Promise.all([
    rewardsQuery.execute(),
    rewardSummaryQuery.executeTakeFirstOrThrow(),
    callbackSummaryQuery.executeTakeFirstOrThrow(),
    callbacksQuery.execute(),
  ]);

  const page = rewardRows.slice(0, limit);
  const lastReward = page[page.length - 1];

  return {
    network,
    from: from.toISOString(),
    to: to.toISOString(),
    summary: {
      callbacks_received: Number(callbackSummary.callbacks_received),
      callbacks_not_credited: Number(callbackSummary.callbacks_not_credited),
      rewards_credited: Number(rewardSummary.rewards_credited),
      coins_credited: rewardSummary.coins_credited,
      unique_users: Number(rewardSummary.unique_users),
      latest_credit_at: rewardSummary.latest_credit_at?.toISOString() ?? null,
    },
    rewards: page.map((row) => ({
      ...row,
      created_at: row.created_at.toISOString(),
      hold_until: row.hold_until?.toISOString() ?? null,
    })),
    next_cursor: rewardRows.length > limit ? (lastReward?.id ?? null) : null,
    recent_callbacks: callbackRows.map((row) => ({
      ...row,
      created_at: row.created_at.toISOString(),
    })),
  };
}
