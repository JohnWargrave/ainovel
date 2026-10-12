import { db } from '../../db/index.js';

interface OfferwallFeature {
  enabled?: boolean;
  networks?: string[];
  shares?: Record<string, number>;
}

// region_config.features.offerwall.shares is keyed by trust_level as a string ('0'..'3') — see
// 1700000000014_seed_region_config.cjs. This is the first code to read region_config.features at
// all (nothing did before this milestone); no caching yet for the same reason as network-config.ts.
export async function getOfferwallShare(regionId: string, trustLevel: number): Promise<number> {
  const row = await db
    .selectFrom('region_config')
    .select('features')
    .where('region_id', '=', regionId)
    .executeTakeFirst();
  const features = row?.features as
    { offerwall?: OfferwallFeature; economy?: { share_rate_factor?: number } } | undefined;
  const shares = features?.offerwall?.shares;
  const configured = shares?.[String(trustLevel)] ?? 0;
  const factor = features?.economy?.share_rate_factor;
  return configured * (typeof factor === 'number' && factor >= 0 && factor <= 1 ? factor : 1);
}
