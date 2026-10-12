import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';

// Daily-earning modules resolve their region from `users.region_id`, never from the request IP:
// the feature gate and the reward table a user sees must not change when they connect through a
// VPN. region_id is NOT NULL with an FK to region_config, so the join always matches.
export interface UserRegionFeatures {
  regionId: string;
  timezone: string;
  features: Record<string, unknown>;
}

export async function loadUserRegionFeatures(userId: string): Promise<UserRegionFeatures> {
  const row = await db
    .selectFrom('users')
    .innerJoin('region_config', 'region_config.region_id', 'users.region_id')
    .select([
      'users.region_id as region_id',
      'users.status as status',
      'region_config.features as features',
    ])
    .where('users.id', '=', userId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError('USER_NOT_FOUND', 'User not found', 404);
  }
  // Every daily-earning entry point (check-in, tasks) resolves its region through here, so this is
  // the one place that has to enforce account standing — without it an admin suspend/ban still let
  // the account mint coin every day. Codes and generic wording match
  // rewarded-ads/intent.service.ts (05-FRAUD-ENGINE.md §4/§6: distinguish permanent ban from
  // automatic soft-ban, never reveal which rule fired).
  if (row.status === 'banned') {
    throw new AppError('EARNING_BLOCKED', 'User is not in good standing to earn', 403);
  }
  if (row.status === 'suspended') {
    throw new AppError(
      'EARNING_SUSPENDED',
      'Earning is temporarily unavailable for this account',
      403,
    );
  }
  const features = (row.features ?? {}) as Record<string, unknown>;
  // Falls back to UTC rather than throwing: a region without an explicit timezone still gets a
  // consistent (if not local) day boundary instead of a 500 on every claim.
  const timezone = typeof features['timezone'] === 'string' ? features['timezone'] : 'UTC';
  return { regionId: row.region_id, timezone, features };
}

export function readFeature<T extends object>(
  features: Record<string, unknown>,
  key: string,
): Partial<T> {
  return (features[key] as Partial<T> | undefined) ?? {};
}
