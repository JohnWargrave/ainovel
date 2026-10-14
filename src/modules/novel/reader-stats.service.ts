import { db } from '../../db/index.js';
import { checkinStreak } from '../earning/checkin.service.js';
import type { ReadingStatsResponse } from './schemas.js';

// The three numbers on the profile screen. All-time, across every novel the user has opened.
export async function getReadingStats(userId: string): Promise<ReadingStatsResponse> {
  const [reading, streak] = await Promise.all([
    db
      .selectFrom('novel_read_progress')
      .select((eb) => [
        eb.fn.count<string>('completed_at').as('chapters_read'),
        eb.fn.coalesce(eb.fn.sum<string>('read_time_s'), eb.lit(0)).as('reading_seconds'),
      ])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow(),
    checkinStreak(userId),
  ]);
  return {
    chapters_read: Number(reading.chapters_read),
    reading_seconds: Number(reading.reading_seconds),
    checkin_streak: streak,
  };
}
