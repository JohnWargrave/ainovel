import { uuidv7 } from 'uuidv7';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { invalidateConfigCache } from '../config/config.service.js';
import type { SpinConfigAdmin, UpdateSpinConfig } from './admin-schemas.js';
import {
  expectedValue,
  FREE_TABLE_EV_MAX,
  FREE_TABLE_EV_MIN,
  validatePrizeTable,
  type SpinMode,
  type SpinPrize,
} from './spin.service.js';

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

// The roles a table plays decide which payout rule its prizes must meet. A table no region uses yet
// is held to the paid rule, the looser of the two, so it can still be drafted.
function modesFor(usage: RegionUsage): SpinMode[] {
  const modes = [...new Set(usage.map((entry) => entry.role))];
  return modes.length > 0 ? modes : ['paid'];
}

// Stored tables are read leniently here: a table the spin itself would reject must still open in the
// CMS so it can be fixed.
function storedPrizes(raw: unknown): SpinPrize[] {
  return Array.isArray(raw)
    ? raw.filter(
        (entry): entry is SpinPrize =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as SpinPrize).slot === 'number',
      )
    : [];
}

function serialize(
  row: {
    id: string;
    name: string;
    ticket_coin: string | number | bigint;
    max_ev_coin: string | number | bigint;
    daily_cap: number;
    is_active: boolean;
    prizes: unknown;
    updated_at: Date | string;
  },
  usage: Map<string, RegionUsage>,
): SpinConfigAdmin {
  const usedBy = usage.get(row.id) ?? [];
  const modes = modesFor(usedBy);
  const prizes = storedPrizes(row.prizes);
  const maxEv = Number(row.max_ev_coin);
  return {
    id: row.id,
    name: row.name,
    ticket_coin: row.ticket_coin.toString(),
    max_ev_coin: row.max_ev_coin.toString(),
    daily_cap: row.daily_cap,
    is_active: row.is_active,
    used_by: usedBy,
    prizes: prizes.map((prize) => ({
      slot: prize.slot,
      type: prize.type,
      value: prize.value,
      weight: prize.weight,
      tier: prize.tier,
      label: typeof prize.label === 'string' ? prize.label : null,
    })),
    ev_coin: prizes.length > 0 ? expectedValue(prizes) : 0,
    ev_min: modes.includes('free') ? FREE_TABLE_EV_MIN : null,
    ev_max: modes.includes('free') ? Math.min(FREE_TABLE_EV_MAX, maxEv) : maxEv,
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function validatedPrizes(
  prizes: NonNullable<UpdateSpinConfig['prizes']>,
  maxEvCoin: number,
  usage: RegionUsage,
): SpinPrize[] {
  let validated: SpinPrize[] = [];
  try {
    for (const mode of modesFor(usage)) validated = validatePrizeTable(prizes, maxEvCoin, mode);
  } catch (error) {
    // The same checks a spin runs, reported as the operator's input error rather than a 500.
    if (error instanceof AppError) throw new AppError('SPIN_PRIZES_INVALID', error.message, 400);
    throw error;
  }
  return validated;
}

export async function listSpinConfigs(): Promise<{ items: SpinConfigAdmin[] }> {
  const [rows, usage] = await Promise.all([
    db
      .selectFrom('spin_config')
      .select([
        'id',
        'name',
        'ticket_coin',
        'max_ev_coin',
        'daily_cap',
        'is_active',
        'prizes',
        'updated_at',
      ])
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
    const prizes = input.prizes
      ? validatedPrizes(input.prizes, Number(before.max_ev_coin), usage.get(configId) ?? [])
      : undefined;

    const after = await trx
      .updateTable('spin_config')
      .set({
        ...(input.daily_cap !== undefined ? { daily_cap: input.daily_cap } : {}),
        ...(prizes ? { prizes: JSON.stringify(prizes) } : {}),
        updated_at: new Date(),
      })
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
          before: { daily_cap: before.daily_cap, prizes: before.prizes },
          after: { daily_cap: after.daily_cap, prizes: after.prizes },
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
