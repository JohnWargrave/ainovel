import { computeCoinPrice, convertMyrToUsd, listedUsdValue } from './pricing.js';
import type { NormalizedCatalogItem } from './catalog-source.js';

// 07-CATALOG-CRAWLER.md §3: guardrail thresholds.
const NEEDS_ATTENTION_PCT = 0.2; // price change > 20% vs the last approved price
const OUT_OF_STOCK_STREAK_THRESHOLD = 2; // 2 consecutive runs out of stock -> suggest deactivate

export interface CatalogItemForDiff {
  sku: string;
  coin_price: number;
  usd_cost: number;
  is_active: boolean;
}

export interface CatalogDiff {
  sku: string;
  previous_coin_price: number | null;
  new_usd_cost: number;
  new_coin_price: number;
  price_change_pct: number | null;
  needs_attention: boolean;
  auto_deactivate: boolean;
  stock_out_streak: number;
  suggest_deactivate: boolean;
}

export function computeDiff(
  current: CatalogItemForDiff | undefined,
  normalized: NormalizedCatalogItem,
  fxRate: number,
  priorStockOutStreak: number,
  bufferPct = 0.08,
): CatalogDiff {
  const newUsdCost = convertMyrToUsd(normalized.seagm_price_raw.amount, fxRate);
  const newCoinPrice = computeCoinPrice(newUsdCost, bufferPct);

  const previousCoinPrice = current?.coin_price ?? null;
  const priceChangePct =
    previousCoinPrice !== null && previousCoinPrice > 0
      ? (newCoinPrice - previousCoinPrice) / previousCoinPrice
      : null;
  const needsAttention = priceChangePct !== null && Math.abs(priceChangePct) > NEEDS_ATTENTION_PCT;

  // The only guardrail allowed to touch live catalog automatically: if the new cost already exceeds
  // what we're currently charging (converted back to USD), continuing to sell would be a loss.
  const autoDeactivate =
    current !== undefined && current.is_active && newUsdCost > listedUsdValue(current.coin_price);

  const stockOutStreak = normalized.in_stock ? 0 : priorStockOutStreak + 1;
  const suggestDeactivate = stockOutStreak >= OUT_OF_STOCK_STREAK_THRESHOLD;

  return {
    sku: normalized.sku,
    previous_coin_price: previousCoinPrice,
    new_usd_cost: newUsdCost,
    new_coin_price: newCoinPrice,
    price_change_pct: priceChangePct,
    needs_attention: needsAttention,
    auto_deactivate: autoDeactivate,
    stock_out_streak: stockOutStreak,
    suggest_deactivate: suggestDeactivate,
  };
}
