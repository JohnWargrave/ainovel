// Reads region_config.features.novel. Same "absent is not misconfigured" discipline as the other
// region features: a region that has never been configured falls back to values that mint nothing.

export interface NovelFeature {
  enabled: boolean;
  // 0 is reachable on purpose: reading and progress tracking stay live while the payout is off.
  chapter_reward_coin: number;
  // Assumed reading speed. The minimum read time for a chapter is derived from its server-side word
  // count, so a long chapter needs longer than a short one.
  reading_wpm: number;
  // Fraction of the estimated reading time that counts as "read".
  min_read_ratio: number;
  // Clamp on the derived minimum, so a 50-word chapter still needs some time and a 20k-word one is
  // not unreachable.
  min_read_seconds: number;
  max_read_seconds: number;
  // How far down the chapter the reader must have scrolled (0–1).
  completion_scroll_ratio: number;
  // Rewarded chapters per region-local day.
  chapter_reward_daily_cap: number;
}

export const NOVEL_FEATURE_DEFAULTS: NovelFeature = {
  enabled: false,
  chapter_reward_coin: 0,
  reading_wpm: 300,
  min_read_ratio: 0.5,
  min_read_seconds: 30,
  max_read_seconds: 900,
  completion_scroll_ratio: 0.9,
  chapter_reward_daily_cap: 20,
};

// Shared with admin-schemas.ts so the CMS never accepts a value this reader would replace.
export const NOVEL_FEATURE_BOUNDS = {
  chapter_reward_coin: { min: 0, max: 1_000_000 },
  reading_wpm: { min: 50, max: 2000 },
  min_read_ratio: { min: 0.1, max: 1 },
  min_read_seconds: { min: 5, max: 3600 },
  max_read_seconds: { min: 10, max: 7200 },
  completion_scroll_ratio: { min: 0, max: 1 },
  chapter_reward_daily_cap: { min: 0, max: 10_000 },
} as const;

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

export function parseNovelFeature(featuresValue: unknown): NovelFeature {
  const novel = asRecord(asRecord(featuresValue)['novel']);
  const b = NOVEL_FEATURE_BOUNDS;
  const d = NOVEL_FEATURE_DEFAULTS;
  const minRead = integerInRange(
    novel['min_read_seconds'],
    b.min_read_seconds.min,
    b.min_read_seconds.max,
    d.min_read_seconds,
  );
  const maxRead = integerInRange(
    novel['max_read_seconds'],
    b.max_read_seconds.min,
    b.max_read_seconds.max,
    d.max_read_seconds,
  );
  return {
    enabled: novel['enabled'] === true,
    chapter_reward_coin: integerInRange(
      novel['chapter_reward_coin'],
      b.chapter_reward_coin.min,
      b.chapter_reward_coin.max,
      d.chapter_reward_coin,
    ),
    reading_wpm: integerInRange(
      novel['reading_wpm'],
      b.reading_wpm.min,
      b.reading_wpm.max,
      d.reading_wpm,
    ),
    min_read_ratio: boundedNumber(
      novel['min_read_ratio'],
      b.min_read_ratio.min,
      b.min_read_ratio.max,
      d.min_read_ratio,
    ),
    min_read_seconds: Math.min(minRead, maxRead),
    max_read_seconds: Math.max(minRead, maxRead),
    completion_scroll_ratio: boundedNumber(
      novel['completion_scroll_ratio'],
      b.completion_scroll_ratio.min,
      b.completion_scroll_ratio.max,
      d.completion_scroll_ratio,
    ),
    chapter_reward_daily_cap: integerInRange(
      novel['chapter_reward_daily_cap'],
      b.chapter_reward_daily_cap.min,
      b.chapter_reward_daily_cap.max,
      d.chapter_reward_daily_cap,
    ),
  };
}

// Seconds of verified reading a chapter needs before it can pay out.
export function requiredReadSeconds(wordCount: number, feature: NovelFeature): number {
  const estimated = Math.ceil((wordCount / feature.reading_wpm) * 60 * feature.min_read_ratio);
  return Math.min(Math.max(estimated, feature.min_read_seconds), feature.max_read_seconds);
}
