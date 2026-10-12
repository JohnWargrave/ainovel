import type { Kysely, Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';

type DbLike = Kysely<DB> | Transaction<DB>;

// Manual kill-switch for unbacked minting (01-COIN-ECONOMY.md §5). Lives in the existing
// `region_config.features` jsonb rather than a new column so it is toggled through the same
// PUT /admin/region-config/:region_id that every other feature flag uses — one audited path, no
// second admin endpoint, no migration.
//
// Deliberately read straight from Postgres and NOT through getConfig(): that path is Redis-cached
// for 60s, and a kill-switch that takes a minute to take effect is not a kill-switch. The read is a
// single indexed lookup on a table with one row per region.
export function readMintPaused(features: unknown): boolean {
  if (!features || typeof features !== 'object' || Array.isArray(features)) return false;
  const economy = (features as Record<string, unknown>)['economy'];
  if (!economy || typeof economy !== 'object' || Array.isArray(economy)) return false;
  return (economy as Record<string, unknown>)['mint_paused'] === true;
}

export async function isMintPausedInTx(trx: DbLike, regionId: string): Promise<boolean> {
  const row = await trx
    .selectFrom('region_config')
    .select('features')
    .where('region_id', '=', regionId)
    .executeTakeFirst();
  return readMintPaused(row?.features);
}

export async function isMintPaused(regionId: string): Promise<boolean> {
  return isMintPausedInTx(db, regionId);
}
