// Region-local day boundaries. Every daily-reset feature (spin, check-in, tasks) has to agree on
// when "today" starts, and that is midnight in the *region's* timezone — not UTC. VN is UTC+7, so a
// UTC-based day would flip at 07:00 local and let a user claim twice on one calendar day.
//
// Only the two zones we actually ship are handled (VN and UTC); an unknown zone falls back to UTC
// rather than pulling in a full tz database for a config value that is seeded by migration.
const VN_TIMEZONE = 'Asia/Ho_Chi_Minh';
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DayWindow {
  start: Date;
  end: Date;
}

function offsetMsFor(timezone: string): number {
  return timezone === VN_TIMEZONE ? VN_OFFSET_MS : 0;
}

// [start, end) covering the region-local calendar day that `now` falls in, expressed in UTC.
export function dayWindow(timezone: string, now = new Date()): DayWindow {
  const offsetMs = offsetMsFor(timezone);
  const local = new Date(now.getTime() + offsetMs);
  const startUtcMs =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offsetMs;
  return { start: new Date(startUtcMs), end: new Date(startUtcMs + DAY_MS) };
}

// YYYY-MM-DD of the region-local calendar day — the segment that makes a daily idempotency key
// unique per day (`checkin:<user>:2026-08-10`).
export function dayKey(timezone: string, now = new Date()): string {
  const local = new Date(now.getTime() + offsetMsFor(timezone));
  return local.toISOString().slice(0, 10);
}

// Ordinal number of the region-local calendar day an instant falls in. Only differences between
// two of these are meaningful — consecutive check-ins are exactly 1 apart, which is what streak
// arithmetic needs.
export function dayIndex(timezone: string, at: Date): number {
  return Math.floor((at.getTime() + offsetMsFor(timezone)) / DAY_MS);
}
