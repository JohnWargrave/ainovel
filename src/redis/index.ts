import { Redis } from 'ioredis';
import { env } from '../config/env.js';

// 4 separate clients/roles per 15 §4 — kept apart so cache eviction pressure, rate-limit
// counters, distributed locks, and BullMQ's own key usage never collide or block each other.
export const cacheRedis = new Redis(env.REDIS_URL, { db: 0 });
export const rateLimitRedis = new Redis(env.REDIS_URL, { db: 1 });
export const lockRedis = new Redis(env.REDIS_URL, { db: 2 });
export const queueRedis = new Redis(env.REDIS_URL, {
  db: 3,
  maxRetriesPerRequest: null, // required by BullMQ
});

export async function closeRedis(): Promise<void> {
  await Promise.all([
    cacheRedis.quit(),
    rateLimitRedis.quit(),
    lockRedis.quit(),
    queueRedis.quit(),
  ]);
}
