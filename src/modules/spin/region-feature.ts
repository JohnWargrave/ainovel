import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';

export interface SpinFeature {
  enabled: boolean;
  tableId: string | null;
  freeTableId: string | null;
  timezone: string;
  oddsDisclosure: string;
}

interface RegionFeatures {
  spin?: {
    enabled?: boolean;
    table_id?: unknown;
    free_table_id?: unknown;
    timezone?: unknown;
    odds_disclosure?: unknown;
  };
}

const DEFAULT_FEATURE: SpinFeature = {
  enabled: false,
  tableId: null,
  freeTableId: null,
  timezone: 'UTC',
  oddsDisclosure: 'Displayed odds are base odds; pity can improve high-tier odds.',
};

export async function getSpinFeature(regionId: string): Promise<SpinFeature> {
  const row = await db
    .selectFrom('region_config')
    .select('features')
    .where('region_id', '=', regionId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError('SPIN_CONFIG_MISSING', 'Spin config is missing', 500);
  }
  const parsed = row.features as RegionFeatures;
  const spin = parsed.spin;
  return {
    enabled: spin?.enabled === true,
    tableId: typeof spin?.table_id === 'string' ? spin.table_id : DEFAULT_FEATURE.tableId,
    freeTableId:
      typeof spin?.free_table_id === 'string' ? spin.free_table_id : DEFAULT_FEATURE.freeTableId,
    timezone: typeof spin?.timezone === 'string' ? spin.timezone : DEFAULT_FEATURE.timezone,
    oddsDisclosure:
      typeof spin?.odds_disclosure === 'string'
        ? spin.odds_disclosure
        : DEFAULT_FEATURE.oddsDisclosure,
  };
}
