import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { invalidateConfigCache } from '../config/config.service.js';
import { insertAudit, type NovelActor } from './admin.service.js';
import { parseNovelFeature } from './region-feature.js';
import type { NovelRegionSettings, UpdateNovelRegionSettings } from './admin-schemas.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function serialize(row: {
  region_id: string;
  features: unknown;
  updated_at: Date | string;
}): NovelRegionSettings {
  const timezone = asRecord(row.features)['timezone'];
  return {
    region_id: row.region_id,
    ...parseNovelFeature(row.features),
    // Same fallback as loadUserRegionFeatures, so the CMS shows the day boundary the cap really uses.
    timezone: typeof timezone === 'string' ? timezone : 'UTC',
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export async function listNovelSettings(): Promise<{ items: NovelRegionSettings[] }> {
  const rows = await db
    .selectFrom('region_config')
    .select(['region_id', 'features', 'updated_at'])
    .orderBy('region_id', 'asc')
    .execute();
  return { items: rows.map(serialize) };
}

export async function updateNovelSettings(
  regionId: string,
  input: UpdateNovelRegionSettings,
  actor: NovelActor,
  ip: string,
): Promise<NovelRegionSettings> {
  if (input.min_read_seconds > input.max_read_seconds) {
    throw new AppError(
      'INVALID_SETTINGS',
      'min_read_seconds must not exceed max_read_seconds',
      400,
    );
  }
  const updated = await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('region_config')
      .selectAll()
      .where('region_id', '=', regionId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError('CONFIG_NOT_FOUND', 'Region config not found', 404);

    const features = asRecord(before.features);
    // Spread the stored object: keys this form does not expose must survive.
    const novel = { ...asRecord(features['novel']), ...input };
    const updatedAt = new Date();
    await trx
      .updateTable('region_config')
      .set({ features: JSON.stringify({ ...features, novel }), updated_at: updatedAt })
      .where('region_id', '=', regionId)
      .execute();
    const after = serialize({
      region_id: regionId,
      features: { ...features, novel },
      updated_at: updatedAt,
    });
    await insertAudit(
      trx,
      actor,
      'NOVEL_SETTINGS_UPDATED',
      'region_config',
      null,
      {
        region_id: regionId,
        before: serialize(before),
        after,
      },
      ip,
    );
    return after;
  });

  // /config ships the parsed novel feature and is Redis-cached per region.
  await invalidateConfigCache();
  return updated;
}
