import { uuidv7 } from 'uuidv7';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { invalidateConfigCache } from '../config/config.service.js';
import type { SpinConfigAdmin, UpdateSpinConfig } from './admin-schemas.js';

export interface SpinConfigActor {
  id: string;
  role: string;
}

type RegionUsage = SpinConfigAdmin['used_by'];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// One spin table can back several regions — VN and ROW ship pointing at the same seeded table today —
// so an operator editing a cap has to see everyone the edit lands on before they save.
async function loadRegionUsage(): Promise<Map<string, RegionUsage>> {
  const rows = await db
    .selectFrom('region_config')
    .select(['region_id', 'features'])
    .orderBy('region_id', 'asc')
    .execute();
  const usage = new Map<string, RegionUsage>();
  for (const row of rows) {
    const spin = asRecord(asRecord(row.features)['spin']);
    for (const [key, role] of [
      ['table_id', 'paid'],
      ['free_table_id', 'free'],
    ] as const) {
      const configId = spin[key];
      if (typeof configId !== 'string') continue;
      const entries = usage.get(configId) ?? [];
      entries.push({ region_id: row.region_id, role });
      usage.set(configId, entries);
    }
  }
  return usage;
}

function serialize(
  row: {
    id: string;
    name: string;
    ticket_coin: string | number | bigint;
    max_ev_coin: string | number | bigint;
    daily_cap: number;
    is_active: boolean;
    updated_at: Date | string;
  },
  usage: Map<string, RegionUsage>,
): SpinConfigAdmin {
  return {
    id: row.id,
    name: row.name,
    ticket_coin: row.ticket_coin.toString(),
    max_ev_coin: row.max_ev_coin.toString(),
    daily_cap: row.daily_cap,
    is_active: row.is_active,
    used_by: usage.get(row.id) ?? [],
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export async function listSpinConfigs(): Promise<{ items: SpinConfigAdmin[] }> {
  const [rows, usage] = await Promise.all([
    db
      .selectFrom('spin_config')
      .select(['id', 'name', 'ticket_coin', 'max_ev_coin', 'daily_cap', 'is_active', 'updated_at'])
      .orderBy('name', 'asc')
      .execute(),
    loadRegionUsage(),
  ]);
  return { items: rows.map((row) => serialize(row, usage)) };
}

export async function updateSpinConfig(
  configId: string,
  input: UpdateSpinConfig,
  actor: SpinConfigActor,
  ip: string,
): Promise<SpinConfigAdmin> {
  const usage = await loadRegionUsage();
  const updated = await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('spin_config')
      .selectAll()
      .where('id', '=', configId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError('SPIN_CONFIG_NOT_FOUND', 'Spin config not found', 404);

    const after = await trx
      .updateTable('spin_config')
      .set({ daily_cap: input.daily_cap, updated_at: new Date() })
      .where('id', '=', configId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: actor.id,
        action: 'SPIN_CONFIG_UPDATED',
        target_type: 'spin_config',
        target_id: configId,
        detail: JSON.stringify({
          before: { daily_cap: before.daily_cap },
          after: { daily_cap: after.daily_cap },
        }),
        ip,
      })
      .execute();

    return serialize(after, usage);
  });

  // buildSpinFeature copies spin_config.daily_cap into the /config payload, and that payload is
  // Redis-cached per region — without this the app shows the old cap for up to the TTL while POST
  // /spin already enforces the new one.
  await invalidateConfigCache();
  return updated;
}
