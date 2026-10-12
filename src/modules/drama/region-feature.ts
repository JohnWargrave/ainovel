// Reads region_config.features.drama. Same shape and same "absent is not misconfigured" discipline
// as rewarded-ads/region-feature.ts — a region that has never been configured falls back to values
// that mint nothing rather than to a 500.

export interface DramaFeature {
  enabled: boolean;
  // 0 means "configured, but pays nothing" and is deliberately reachable: it is how an operator
  // keeps the player and its progress tracking live while turning the payout off.
  episode_reward_coin: number;
  // Fraction of duration_s that counts as finished. Configurable rather than fixed at 0.8 so the
  // threshold can be tuned per region without a redeploy.
  completion_ratio: number;
  // Rewarded episodes per region-local day. Named to match the key already seeded by migration 14.
  episode_reward_daily_cap: number;
}

const DEFAULTS: DramaFeature = {
  enabled: false,
  episode_reward_coin: 0,
  completion_ratio: 0.8,
  episode_reward_daily_cap: 20,
};

// A ratio below this would let a "watch" be credited on a few seconds of a long episode; above it,
// players that stop reporting at the credits could never finish one.
const COMPLETION_RATIO_MIN = 0.1;
const COMPLETION_RATIO_MAX = 1;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export function parseDramaFeature(featuresValue: unknown): DramaFeature {
  const drama = asRecord(asRecord(featuresValue)['drama']);
  return {
    enabled: drama['enabled'] === true,
    episode_reward_coin: integerInRange(
      drama['episode_reward_coin'],
      0,
      1_000_000,
      DEFAULTS.episode_reward_coin,
    ),
    completion_ratio: boundedNumber(
      drama['completion_ratio'],
      COMPLETION_RATIO_MIN,
      COMPLETION_RATIO_MAX,
      DEFAULTS.completion_ratio,
    ),
    episode_reward_daily_cap: integerInRange(
      drama['episode_reward_daily_cap'],
      0,
      10_000,
      DEFAULTS.episode_reward_daily_cap,
    ),
  };
}
