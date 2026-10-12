import { sql, type RawBuilder } from 'kysely';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { UNBACKED_ENTRY_TYPES } from '../wallet-ledger/ledger.service.js';
import { getBackingRatio } from '../wallet-ledger/economy-counters.js';
import { isMintPaused } from '../wallet-ledger/mint-switch.js';
import type {
  AnalyticsTimeseriesQuery,
  AnalyticsTimeseriesResponse,
  DashboardResponse,
  EconomyAnalyticsQuery,
  EconomyAnalyticsResponse,
} from './schemas.js';
import { listAuditLog } from './audit.service.js';

const DEFAULT_WINDOW_DAYS = 30;

function parseBound(raw: string | undefined, fallback: Date, label: string): Date {
  if (raw === undefined) return fallback;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError('INVALID_RANGE', `${label} is not a valid date`, 400);
  }
  return parsed;
}

// `to` is exclusive on the upper end after a bare date like "2026-08-09" is widened to the end of
// that day — otherwise a same-day from/to would select a zero-width range and report an empty economy.
function resolveRange(query: EconomyAnalyticsQuery): { from: Date; to: Date } {
  const now = new Date();
  const to = parseBound(query.to, now, 'to');
  const from = parseBound(
    query.from,
    new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000),
    'from',
  );
  // A bare YYYY-MM-DD parses to midnight UTC; without this the caller's last day is silently excluded.
  const toInclusive = /^\d{4}-\d{2}-\d{2}$/.test(query.to ?? '')
    ? new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1)
    : to;
  if (from.getTime() > toInclusive.getTime()) {
    throw new AppError('INVALID_RANGE', 'from must not be after to', 400);
  }
  return { from, to: toInclusive };
}

interface Range {
  from: Date;
  to: Date;
  region: string | null;
}

// Every query below joins `users` for the region filter; coin_ledger/earning_events/redemptions
// carry no region column of their own, and a user's region_id never changes after signup.
async function loadLedgerTotals(
  range: Range,
): Promise<{ minted: Map<string, bigint>; burned: Map<string, bigint> }> {
  let query = db
    .selectFrom('coin_ledger')
    .innerJoin('users', 'users.id', 'coin_ledger.user_id')
    .select([
      'coin_ledger.entry_type as entry_type',
      sql<string>`sum(case when coin_ledger.amount > 0 then coin_ledger.amount else 0 end)`.as(
        'minted',
      ),
      sql<string>`sum(case when coin_ledger.amount < 0 then -coin_ledger.amount else 0 end)`.as(
        'burned',
      ),
    ])
    .where('coin_ledger.created_at', '>=', range.from)
    .where('coin_ledger.created_at', '<=', range.to)
    .groupBy('coin_ledger.entry_type');
  if (range.region) {
    query = query.where('users.region_id', '=', range.region);
  }

  const rows = await query.execute();
  const minted = new Map<string, bigint>();
  const burned = new Map<string, bigint>();
  for (const row of rows) {
    const mintedAmount = BigInt(row.minted);
    const burnedAmount = BigInt(row.burned);
    // HOLD_RELEASE writes a matching +/- pair, so an entry type can legitimately appear on both
    // sides. Zero buckets are dropped so the response has no noise rows.
    if (mintedAmount > 0n) minted.set(row.entry_type, mintedAmount);
    if (burnedAmount > 0n) burned.set(row.entry_type, burnedAmount);
  }
  return { minted, burned };
}

async function loadRedeemedUsdCost(range: Range): Promise<number> {
  let query = db
    .selectFrom('redemptions')
    .innerJoin('users', 'users.id', 'redemptions.user_id')
    .select((eb) =>
      eb.fn.coalesce(eb.fn.sum<string>('redemptions.usd_cost_est'), sql`0`).as('cost'),
    )
    // Cost is only real once the code is handed over — pending/rejected rows would overstate spend.
    .where('redemptions.status', '=', 'DELIVERED')
    .where('redemptions.created_at', '>=', range.from)
    .where('redemptions.created_at', '<=', range.to);
  if (range.region) {
    query = query.where('users.region_id', '=', range.region);
  }
  const row = await query.executeTakeFirstOrThrow();
  return Number(row.cost);
}

async function loadRevenueUsd(range: Range): Promise<number> {
  let query = db
    .selectFrom('earning_events')
    .innerJoin('users', 'users.id', 'earning_events.user_id')
    .select((eb) =>
      eb.fn.coalesce(eb.fn.sum<string>('earning_events.payout_usd'), sql`0`).as('revenue'),
    )
    .where('earning_events.status', '=', 'credited')
    .where('earning_events.created_at', '>=', range.from)
    .where('earning_events.created_at', '<=', range.to);
  if (range.region) {
    query = query.where('users.region_id', '=', range.region);
  }
  const row = await query.executeTakeFirstOrThrow();
  return Number(row.revenue);
}

async function loadClawbackRates(range: Range): Promise<Record<string, number>> {
  let query = db
    .selectFrom('earning_events')
    .innerJoin('users', 'users.id', 'earning_events.user_id')
    .select([
      'earning_events.source as source',
      sql<string>`count(*) filter (where earning_events.status = 'credited')`.as('credited'),
      sql<string>`count(*) filter (where earning_events.status = 'clawed_back')`.as('clawed_back'),
    ])
    .where('earning_events.created_at', '>=', range.from)
    .where('earning_events.created_at', '<=', range.to)
    .groupBy('earning_events.source');
  if (range.region) {
    query = query.where('users.region_id', '=', range.region);
  }

  const rows = await query.execute();
  const rates: Record<string, number> = {};
  for (const row of rows) {
    const credited = Number(row.credited);
    const clawedBack = Number(row.clawed_back);
    const total = credited + clawedBack;
    // Sources with no terminal events yet are omitted rather than reported as 0% — "no data" and
    // "zero clawbacks" are different facts and 05-FRAUD-ENGINE.md §7 acts on this number.
    if (total === 0) continue;
    rates[row.source] = clawedBack / total;
  }
  return rates;
}

function sumValues(map: Map<string, bigint>): bigint {
  let total = 0n;
  for (const value of map.values()) total += value;
  return total;
}

function toStringRecord(map: Map<string, bigint>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of map) out[key] = value.toString();
  return out;
}

export async function getEconomyAnalytics(
  query: EconomyAnalyticsQuery,
): Promise<EconomyAnalyticsResponse> {
  const { from, to } = resolveRange(query);
  const region = query.region ?? null;
  const range: Range = { from, to, region };

  const [ledger, redeemedUsdCost, revenueUsd, clawbackRates] = await Promise.all([
    loadLedgerTotals(range),
    loadRedeemedUsdCost(range),
    loadRevenueUsd(range),
    loadClawbackRates(range),
  ]);

  const mintedTotal = sumValues(ledger.minted);
  let unbacked = 0n;
  for (const entryType of UNBACKED_ENTRY_TYPES) {
    unbacked += ledger.minted.get(entryType) ?? 0n;
  }

  // These two are read from the Redis day counters and are region-scoped; without a region there is
  // no single ratio to report, so they stay null/false rather than guessing an aggregate.
  const [backingRatioToday, mintPaused] = await Promise.all([
    region ? getBackingRatio(region) : Promise.resolve(null),
    region ? isMintPaused(region) : Promise.resolve(false),
  ]);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    region,
    coin_minted_by_source: toStringRecord(ledger.minted),
    coin_burned_by_sink: toStringRecord(ledger.burned),
    coin_minted_total: mintedTotal.toString(),
    coin_burned_total: sumValues(ledger.burned).toString(),
    unbacked_coin: unbacked.toString(),
    unbacked_pct: mintedTotal === 0n ? 0 : Number(unbacked) / Number(mintedTotal),
    coin_redeemed_usd_cost: redeemedUsdCost,
    revenue_usd: revenueUsd,
    clawback_rate_by_network: clawbackRates,
    backing_ratio_today: backingRatioToday,
    mint_paused: mintPaused,
  };
}

const DEFAULT_TIMESERIES_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Bucketed in UTC explicitly rather than by the server's local zone, so the same range returns the
// same buckets regardless of where the API happens to be deployed.
const UTC_DAY = (column: string): RawBuilder<string> =>
  sql<string>`to_char(${sql.ref(column)} at time zone 'utc', 'YYYY-MM-DD')`;

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every day in [from, to], inclusive, oldest first. */
function dayKeysBetween(from: Date, to: Date): string[] {
  const keys: string[] = [];
  for (let time = from.getTime(); time <= to.getTime(); time += DAY_MS) {
    keys.push(utcDayKey(new Date(time)));
  }
  return keys;
}

async function loadCoinByDay(
  from: Date,
  region: string | null,
): Promise<Map<string, { minted: bigint; burned: bigint }>> {
  let query = db
    .selectFrom('coin_ledger')
    .innerJoin('users', 'users.id', 'coin_ledger.user_id')
    .select([
      UTC_DAY('coin_ledger.created_at').as('day'),
      sql<string>`sum(case when coin_ledger.amount > 0 then coin_ledger.amount else 0 end)`.as(
        'minted',
      ),
      sql<string>`sum(case when coin_ledger.amount < 0 then -coin_ledger.amount else 0 end)`.as(
        'burned',
      ),
    ])
    .where('coin_ledger.created_at', '>=', from)
    .groupBy(UTC_DAY('coin_ledger.created_at'));
  if (region) query = query.where('users.region_id', '=', region);

  const rows = await query.execute();
  return new Map(
    rows.map((row) => [row.day, { minted: BigInt(row.minted), burned: BigInt(row.burned) }]),
  );
}

async function loadNewUsersByDay(from: Date, region: string | null): Promise<Map<string, number>> {
  let query = db
    .selectFrom('users')
    .select([UTC_DAY('users.created_at').as('day'), sql<string>`count(*)`.as('total')])
    .where('users.created_at', '>=', from)
    .groupBy(UTC_DAY('users.created_at'));
  if (region) query = query.where('users.region_id', '=', region);

  const rows = await query.execute();
  return new Map(rows.map((row) => [row.day, Number(row.total)]));
}

async function loadRevenueByDay(from: Date, region: string | null): Promise<Map<string, number>> {
  let query = db
    .selectFrom('earning_events')
    .innerJoin('users', 'users.id', 'earning_events.user_id')
    .select([
      UTC_DAY('earning_events.created_at').as('day'),
      sql<string>`coalesce(sum(earning_events.payout_usd), 0)`.as('revenue'),
    ])
    .where('earning_events.status', '=', 'credited')
    .where('earning_events.created_at', '>=', from)
    .groupBy(UTC_DAY('earning_events.created_at'));
  if (region) query = query.where('users.region_id', '=', region);

  const rows = await query.execute();
  return new Map(rows.map((row) => [row.day, Number(row.revenue)]));
}

export async function getAnalyticsTimeseries(
  query: AnalyticsTimeseriesQuery,
): Promise<AnalyticsTimeseriesResponse> {
  const days = query.days ?? DEFAULT_TIMESERIES_DAYS;
  const region = query.region ?? null;
  // Anchored to UTC midnight so the first and last buckets are whole days rather than partial ones
  // that would render as an unexplained dip at each end of the chart.
  const to = new Date(`${utcDayKey(new Date())}T00:00:00.000Z`);
  const from = new Date(to.getTime() - (days - 1) * DAY_MS);

  const [coin, newUsers, revenue] = await Promise.all([
    loadCoinByDay(from, region),
    loadNewUsersByDay(from, region),
    loadRevenueByDay(from, region),
  ]);

  const points = dayKeysBetween(from, to).map((date) => {
    const bucket = coin.get(date);
    return {
      date,
      coin_minted: (bucket?.minted ?? 0n).toString(),
      coin_burned: (bucket?.burned ?? 0n).toString(),
      new_users: newUsers.get(date) ?? 0,
      revenue_usd: revenue.get(date) ?? 0,
    };
  });

  return { from: from.toISOString(), to: to.toISOString(), region, points };
}

export async function getDashboard(): Promise<DashboardResponse> {
  const [users, redemptions, fraudFlags, catalogItems, economy, regions, recentAuditLog] =
    await Promise.all([
      db
        .selectFrom('users')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('redemptions')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('status', 'in', ['REQUESTED', 'FRAUD_REVIEW', 'APPROVED', 'PURCHASING'])
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('fraud_flags')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('status', '=', 'open')
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('catalog_items')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('is_active', '=', true)
        .executeTakeFirstOrThrow(),
      getEconomyAnalytics({}),
      db.selectFrom('region_config').select('region_id').orderBy('region_id', 'asc').execute(),
      listAuditLog({ limit: 10 }),
    ]);

  return {
    counts: {
      users_total: Number(users.count),
      redemptions_pending: Number(redemptions.count),
      fraud_flags_open: Number(fraudFlags.count),
      catalog_items_active: Number(catalogItems.count),
    },
    economy,
    regions: regions.map((row) => row.region_id),
    recent_audit_log: recentAuditLog.items,
  };
}
