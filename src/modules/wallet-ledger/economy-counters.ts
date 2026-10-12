import { cacheRedis } from '../../redis/index.js';
import { COIN_PER_USD } from '../../lib/economy.js';

// I6 infra only (15 §6): Redis counters per region, incremented immediately after each ledger
// transaction commits (not batched). Alerting/kill-switch tiers on top of getBackingRatio() are
// explicitly out of scope for Milestone A — this just makes the ratio queryable.
const REVENUE_MICRO_USD_SCALE = 1_000_000;

function counterKey(region: string, metric: 'minted' | 'revenue_micro_usd'): string {
  const day = new Date().toISOString().slice(0, 10);
  return `econ:${metric}:${region}:${day}`;
}

export async function recordMint(region: string, coinAmount: number): Promise<void> {
  if (coinAmount <= 0) return;
  await cacheRedis.incrby(counterKey(region, 'minted'), coinAmount);
}

export async function recordRevenue(region: string, usdAmount: number): Promise<void> {
  if (usdAmount <= 0) return;
  // Stored as integer micro-USD (no INCRBYFLOAT) so repeated increments never accumulate float error.
  await cacheRedis.incrby(
    counterKey(region, 'revenue_micro_usd'),
    Math.round(usdAmount * REVENUE_MICRO_USD_SCALE),
  );
}

// Null when nothing has been minted yet today for the region — "no ratio" rather than a misleading 0/0.
export async function getBackingRatio(region: string): Promise<number | null> {
  const [mintedRaw, revenueRaw] = await Promise.all([
    cacheRedis.get(counterKey(region, 'minted')),
    cacheRedis.get(counterKey(region, 'revenue_micro_usd')),
  ]);
  const mintedCoin = Number(mintedRaw ?? 0);
  if (mintedCoin === 0) return null;

  const revenueUsd = Number(revenueRaw ?? 0) / REVENUE_MICRO_USD_SCALE;
  const mintedUsd = mintedCoin / COIN_PER_USD;
  return revenueUsd / mintedUsd;
}
