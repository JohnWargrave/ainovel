import { rateLimitRedis } from '../redis/index.js';
import { AppError } from './errors.js';

// 15§4: fixed-window counter on the shared rate-limit Redis (db=1). Used by any public,
// unauthenticated endpoint that needs its own budget independent of IP allowlist/signature checks
// (postback/:network in 1.3, admob_ssv callback in 1.4).
export async function checkRateLimit(
  keyPrefix: string,
  ip: string,
  windowS: number,
  maxRequests: number,
): Promise<void> {
  await checkSubjectRateLimit(keyPrefix, ip, windowS, maxRequests);
}

const INCR_WITH_TTL = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;

export async function checkSubjectRateLimit(
  keyPrefix: string,
  subject: string,
  windowS: number,
  maxRequests: number,
): Promise<void> {
  const key = `${keyPrefix}:ratelimit:${subject}`;
  // INCR and EXPIRE in one script: as two round-trips, a failed EXPIRE would leave a counter that
  // never expires and block the subject permanently.
  const count = Number(await rateLimitRedis.eval(INCR_WITH_TTL, 1, key, windowS));
  if (count > maxRequests) {
    throw new AppError('RATE_LIMITED', `Too many requests to ${keyPrefix}`, 429);
  }
}
