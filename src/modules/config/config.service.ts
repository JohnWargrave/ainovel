import { createHash } from 'node:crypto';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { COIN_PER_USD, MIN_REDEMPTION_USD } from '../../lib/economy.js';
import { cacheRedis } from '../../redis/index.js';
import { env } from '../../config/env.js';
import { parseRewardedAdsFeature } from '../rewarded-ads/region-feature.js';
import { parseNovelFeature } from '../novel/region-feature.js';
import type { ConfigResponse } from './schemas.js';

const CONFIG_CACHE_PREFIX = 'config:v1:';
const CONFIG_CACHE_TTL_S = 60;
const DEFAULT_TRUST_LEVEL = '0';

interface RegionFeatures {
  novel?: Record<string, unknown>;
  spin?: {
    enabled?: boolean;
    table_id?: unknown;
    odds_disclosure?: unknown;
  };
  offerwall?: { enabled?: boolean; networks?: unknown; shares?: Record<string, unknown> };
  rewarded_ads?: {
    enabled?: boolean;
    daily_cap?: unknown;
    cooldown_s?: unknown;
  };
  checkin?: { enabled?: boolean; rewards?: unknown };
  tasks?: { enabled?: boolean };
  redemption?: { enabled?: boolean };
  referral?: {
    enabled?: boolean;
    pct?: unknown;
    milestone_bonus_coin?: unknown;
    milestone_bonus_threshold?: unknown;
    credit_immediately?: unknown;
  };
}

interface CachedConfig {
  payload: ConfigResponse;
  etag: string;
}

export interface ConfigResult {
  payload: ConfigResponse;
  etag: string;
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('CONFIG_MALFORMED', 'Region config is malformed', 500);
  }
  return value as Record<string, unknown>;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function etagFor(payload: ConfigResponse): string {
  return `"${createHash('sha256').update(stableStringify(payload)).digest('hex')}"`;
}

function cacheKey(regionId: string): string {
  return `${CONFIG_CACHE_PREFIX}${regionId}`;
}

function coerceNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function buildSpinFeature(features: RegionFeatures): Promise<Record<string, unknown>> {
  if (features.spin?.enabled !== true || typeof features.spin.table_id !== 'string') {
    return { enabled: false };
  }
  const config = await db
    .selectFrom('spin_config')
    .select(['ticket_coin', 'daily_cap'])
    .where('id', '=', features.spin.table_id)
    .where('is_active', '=', true)
    .executeTakeFirst();
  if (!config) {
    return { enabled: false };
  }
  return {
    enabled: true,
    ticket_coin: Number(config.ticket_coin),
    daily_cap: config.daily_cap,
    odds_disclosure:
      typeof features.spin.odds_disclosure === 'string'
        ? features.spin.odds_disclosure
        : 'Displayed odds are base odds; pity can improve high-tier odds.',
  };
}

async function buildPayload(regionId: string, features: RegionFeatures): Promise<ConfigResponse> {
  const share = coerceNumber(features.offerwall?.shares?.[DEFAULT_TRUST_LEVEL]);
  const spin = await buildSpinFeature(features);
  return {
    region: regionId,
    features: {
      // The reward parameters ship here so the reader can render "+N 🪙" without an authenticated
      // round trip. The credit itself is still decided server-side from verified reading time —
      // these are display values, not an authority the client can act on.
      // Spread rather than passed straight through: ConfigFeatureSchema is a Record<string,
      // unknown>, and an interface has no implicit index signature to satisfy it.
      novel: { ...parseNovelFeature(features) },
      spin,
      offerwall: {
        enabled: features.offerwall?.enabled === true,
        networks: Array.isArray(features.offerwall?.networks) ? features.offerwall.networks : [],
        share_pct: share === undefined ? 0 : Math.round(share * 100),
      },
      rewarded_ads: {
        enabled: features.rewarded_ads?.enabled === true,
        daily_cap: coerceNumber(features.rewarded_ads?.daily_cap) ?? 0,
        cooldown_s: coerceNumber(features.rewarded_ads?.cooldown_s) ?? 0,
        // Per ad unit. Shipped here so the app can size each surface's UI without an authenticated
        // round trip per placement; the authoritative remaining quota still comes from
        // GET /earning/rewarded-ad/state?placement=.
        placements: parseRewardedAdsFeature(features).placements,
      },
      checkin: {
        enabled: features.checkin?.enabled === true,
        rewards: Array.isArray(features.checkin?.rewards) ? features.checkin.rewards : [],
      },
      // Gate only — the task list itself lives behind GET /earning/tasks, which is authenticated
      // because each task carries that user's completion state. /config is public and region-cached,
      // so it answers "render the tasks section at all?" and nothing more.
      tasks: { enabled: features.tasks?.enabled === true },
      redemption: { enabled: features.redemption?.enabled === true },
      referral: {
        enabled: features.referral?.enabled === true,
        pct: coerceNumber(features.referral?.pct) ?? 0,
        milestone_bonus_coin: coerceNumber(features.referral?.milestone_bonus_coin) ?? 0,
        milestone_bonus_threshold: coerceNumber(features.referral?.milestone_bonus_threshold) ?? 0,
        credit_immediately: features.referral?.credit_immediately === true,
      },
    },
    coin_per_usd: COIN_PER_USD,
    min_supported_app_version: env.MIN_SUPPORTED_APP_VERSION,
    // D3: minimum redemption is $5 (cheapest gift card). Server-driven so Android doesn't hardcode.
    min_redemption_usd: MIN_REDEMPTION_USD,
  };
}

async function loadConfig(regionId: string): Promise<ConfigResult> {
  const row = await db
    .selectFrom('region_config')
    .select(['features'])
    .where('region_id', '=', regionId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError('CONFIG_NOT_FOUND', 'Region config not found', 500);
  }
  const features = assertRecord(row.features) as RegionFeatures;
  const payload = await buildPayload(regionId, features);
  return { payload, etag: etagFor(payload) };
}

export async function getConfig(regionId: string): Promise<ConfigResult> {
  const key = cacheKey(regionId);
  const cached = await cacheRedis.get(key);
  if (cached) {
    return JSON.parse(cached) as CachedConfig;
  }
  const result = await loadConfig(regionId);
  await cacheRedis.set(key, JSON.stringify(result), 'EX', CONFIG_CACHE_TTL_S);
  return result;
}

export async function invalidateConfigCache(): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [nextCursor, keys] = await cacheRedis.scan(
      cursor,
      'MATCH',
      `${CONFIG_CACHE_PREFIX}*`,
      'COUNT',
      100,
    );
    cursor = nextCursor;
    if (keys.length > 0) {
      deleted += await cacheRedis.del(...keys);
    }
  } while (cursor !== '0');
  return deleted;
}
