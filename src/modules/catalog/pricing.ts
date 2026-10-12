import { COIN_PER_USD } from '../../lib/economy.js';

// 07-CATALOG-CRAWLER.md §3: "FX MYR->USD: rate cấu hình cập nhật tay hàng tuần — thêm biên 1% an toàn."
export function convertMyrToUsd(myrAmount: number, fxRate: number, safetyMarginPct = 0.01): number {
  return myrAmount * fxRate * (1 + safetyMarginPct);
}

// "Giá coin niêm yết = ceil(usd_cost * (1 + buffer) * COIN_PER_USD / 100) * 100" — rounds up to the
// nearest 100 coin. Buffer defaults to 8%, absorbing FX drift + price volatility + fees.
export function computeCoinPrice(usdCost: number, bufferPct = 0.08): number {
  return Math.ceil((usdCost * (1 + bufferPct) * COIN_PER_USD) / 100) * 100;
}

// Inverse of computeCoinPrice's anchor (ignoring buffer, since buffer was already baked in at the
// time the current price was approved) — used only to compare a newly-crawled cost against what the
// currently-listed price represents in USD, for the auto-deactivate guardrail.
export function listedUsdValue(coinPrice: number): number {
  return coinPrice / COIN_PER_USD;
}
