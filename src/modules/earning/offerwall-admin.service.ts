import ipaddr from 'ipaddr.js';
import { uuidv7 } from 'uuidv7';
import type { Transaction } from 'kysely';
import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { invalidateConfigCache } from '../config/config.service.js';
import type {
  CreateOfferwallOfferBody,
  OfferwallOffer,
  OfferwallOfferListQuery,
  OfferwallProvider,
  OfferwallProviderId,
  OfferwallRegionSettings,
  UpdateOfferwallOfferBody,
  UpdateOfferwallProviderBody,
  UpdateOfferwallRegionSettingsBody,
} from './offerwall-admin.schemas.js';

const DEFAULT_SHARES = { '0': 0.3, '1': 0.35, '2': 0.4, '3': 0.5 };
const OFFERWALL_PROVIDERS = ['tapjoy', 'pubscale'] as const;
const POSTBACK_BASE_URL = 'https://api.ainovel.com/postback';

export interface OfferwallAdminActor {
  id: string;
  role: string;
}

interface StoredOfferwallFeature {
  enabled?: unknown;
  networks?: unknown;
  shares?: unknown;
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function parseDate(value: string | null | undefined, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError('INVALID_SCHEDULE', `${field} must be an ISO date`, 400);
  }
  return parsed;
}

function validateSchedule(startsAt: Date | null, endsAt: Date | null): void {
  if (startsAt && endsAt && endsAt <= startsAt) {
    throw new AppError('INVALID_SCHEDULE', 'ends_at must be later than starts_at', 400);
  }
}

function serializeOffer(row: {
  id: string;
  code: string;
  provider: string;
  name: string;
  description: string;
  icon_url: string | null;
  badge_text: string | null;
  placement: string | null;
  region_ids: string[];
  sort_order: number;
  status: string;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): OfferwallOffer {
  return {
    id: row.id,
    code: row.code,
    provider: row.provider,
    name: row.name,
    description: row.description,
    icon_url: row.icon_url,
    badge_text: row.badge_text,
    placement: row.placement,
    region_ids: row.region_ids,
    sort_order: row.sort_order,
    status: row.status as OfferwallOffer['status'],
    starts_at: nullableIso(row.starts_at),
    ends_at: nullableIso(row.ends_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

async function insertAudit(
  trx: Transaction<DB>,
  actor: OfferwallAdminActor,
  action: string,
  targetType: string,
  targetId: string | null,
  detail: unknown,
  ip: string,
): Promise<void> {
  await trx
    .insertInto('audit_log')
    .values({
      id: uuidv7(),
      admin_user_id: actor.id,
      action,
      target_type: targetType,
      target_id: targetId,
      detail: JSON.stringify(detail),
      ip,
    })
    .execute();
}

function assertSupportedProvider(provider: string): asserts provider is OfferwallProviderId {
  if (!OFFERWALL_PROVIDERS.includes(provider as OfferwallProviderId)) {
    throw new AppError('OFFERWALL_PROVIDER_NOT_FOUND', 'Provider not found', 404);
  }
}

async function assertProviderExists(provider: string, trx = db): Promise<void> {
  assertSupportedProvider(provider);
  const row = await trx
    .selectFrom('network_config')
    .select('network')
    .where('network', '=', provider)
    .executeTakeFirst();
  if (!row) throw new AppError('OFFERWALL_PROVIDER_NOT_FOUND', 'Provider not found', 404);
}

async function assertRegionsExist(regionIds: readonly string[], trx = db): Promise<void> {
  if (new Set(regionIds).size !== regionIds.length) {
    throw new AppError('INVALID_REGIONS', 'region_ids must not contain duplicates', 400);
  }
  const rows = await trx
    .selectFrom('region_config')
    .select('region_id')
    .where('region_id', 'in', [...regionIds])
    .execute();
  if (rows.length !== regionIds.length) {
    throw new AppError('INVALID_REGIONS', 'One or more regions do not exist', 400);
  }
}

async function loadOffer(id: string): Promise<OfferwallOffer> {
  const row = await db
    .selectFrom('offerwall_offers')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw new AppError('OFFERWALL_OFFER_NOT_FOUND', 'Offer not found', 404);
  return serializeOffer(row);
}

export async function listOfferwallOffersAdmin(
  query: OfferwallOfferListQuery,
): Promise<{ items: OfferwallOffer[] }> {
  let builder = db
    .selectFrom('offerwall_offers')
    .selectAll()
    .orderBy('sort_order', 'asc')
    .orderBy('code', 'asc');
  if (query.provider) builder = builder.where('provider', '=', query.provider);
  if (query.status) builder = builder.where('status', '=', query.status);
  const rows = await builder.execute();
  return { items: rows.map(serializeOffer) };
}

export async function getOfferwallOfferAdmin(id: string): Promise<OfferwallOffer> {
  return loadOffer(id);
}

export async function createOfferwallOffer(
  actor: OfferwallAdminActor,
  body: CreateOfferwallOfferBody,
  ip: string,
): Promise<OfferwallOffer> {
  const startsAt = parseDate(body.starts_at, 'starts_at') ?? null;
  const endsAt = parseDate(body.ends_at, 'ends_at') ?? null;
  validateSchedule(startsAt, endsAt);
  const id = uuidv7();

  await db.transaction().execute(async (trx) => {
    await assertProviderExists(body.provider, trx);
    await assertRegionsExist(body.region_ids, trx);
    try {
      await trx
        .insertInto('offerwall_offers')
        .values({
          id,
          code: body.code,
          provider: body.provider,
          name: body.name,
          description: body.description ?? '',
          icon_url: body.icon_url ?? null,
          badge_text: body.badge_text ?? null,
          placement: body.placement ?? null,
          region_ids: body.region_ids,
          sort_order: body.sort_order ?? 0,
          status: body.status ?? 'draft',
          starts_at: startsAt,
          ends_at: endsAt,
        })
        .execute();
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new AppError('OFFERWALL_CODE_CONFLICT', 'Offer code already exists', 409);
      }
      throw error;
    }
    await insertAudit(
      trx,
      actor,
      'OFFERWALL_OFFER_CREATED',
      'offerwall_offer',
      id,
      { after: body },
      ip,
    );
  });
  return loadOffer(id);
}

export async function updateOfferwallOffer(
  id: string,
  actor: OfferwallAdminActor,
  patch: UpdateOfferwallOfferBody,
  ip: string,
  auditAction = 'OFFERWALL_OFFER_UPDATED',
): Promise<OfferwallOffer> {
  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('offerwall_offers')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError('OFFERWALL_OFFER_NOT_FOUND', 'Offer not found', 404);

    if (patch.provider !== undefined) await assertProviderExists(patch.provider, trx);
    if (patch.region_ids !== undefined) await assertRegionsExist(patch.region_ids, trx);
    const startsAt = parseDate(patch.starts_at, 'starts_at');
    const endsAt = parseDate(patch.ends_at, 'ends_at');
    validateSchedule(
      startsAt === undefined ? before.starts_at : startsAt,
      endsAt === undefined ? before.ends_at : endsAt,
    );

    try {
      await trx
        .updateTable('offerwall_offers')
        .set({
          ...(patch.code !== undefined ? { code: patch.code } : {}),
          ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.icon_url !== undefined ? { icon_url: patch.icon_url } : {}),
          ...(patch.badge_text !== undefined ? { badge_text: patch.badge_text } : {}),
          ...(patch.placement !== undefined ? { placement: patch.placement } : {}),
          ...(patch.region_ids !== undefined ? { region_ids: patch.region_ids } : {}),
          ...(patch.sort_order !== undefined ? { sort_order: patch.sort_order } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(startsAt !== undefined ? { starts_at: startsAt } : {}),
          ...(endsAt !== undefined ? { ends_at: endsAt } : {}),
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .execute();
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new AppError('OFFERWALL_CODE_CONFLICT', 'Offer code already exists', 409);
      }
      throw error;
    }
    await insertAudit(
      trx,
      actor,
      auditAction,
      'offerwall_offer',
      id,
      { before: serializeOffer(before), patch },
      ip,
    );
  });
  return loadOffer(id);
}

export async function archiveOfferwallOffer(
  id: string,
  actor: OfferwallAdminActor,
  ip: string,
): Promise<OfferwallOffer> {
  return updateOfferwallOffer(id, actor, { status: 'archived' }, ip, 'OFFERWALL_OFFER_ARCHIVED');
}

function envPlacement(provider: string): string | undefined {
  const value =
    provider === 'tapjoy'
      ? env.TAPJOY_PLACEMENT
      : provider === 'pubscale'
        ? env.PUBSCALE_PLACEMENT
        : undefined;
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
}

function envSecret(provider: string): string | undefined {
  const value =
    provider === 'tapjoy'
      ? env.TAPJOY_POSTBACK_SECRET
      : provider === 'pubscale'
        ? env.PUBSCALE_POSTBACK_SECRET
        : undefined;
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
}

function serializeProvider(row: {
  network: string;
  secret_key: string;
  allowed_ips: string[];
  currency_per_usd: string | null;
  hold_hours: number;
  high_value_threshold_usd: string;
  high_value_hold_hours: number;
  credit_immediately: boolean;
  is_active: boolean;
  shadow_mode: boolean;
  display_name: string | null;
  icon_url: string | null;
  placement: string | null;
  updated_at: Date | string;
}): OfferwallProvider {
  const placementOverride = envPlacement(row.network);
  const secret = envSecret(row.network) ?? row.secret_key;
  return {
    provider: row.network,
    display_name: row.display_name,
    icon_url: row.icon_url,
    placement: placementOverride ?? row.placement,
    placement_source: placementOverride ? 'environment' : 'database',
    allowed_ips: row.allowed_ips,
    currency_per_usd: row.currency_per_usd,
    hold_hours: row.hold_hours,
    high_value_threshold_usd: row.high_value_threshold_usd,
    high_value_hold_hours: row.high_value_hold_hours,
    credit_immediately: row.credit_immediately,
    is_active: row.is_active,
    shadow_mode: row.shadow_mode,
    secret_configured: secret.length > 0 && !secret.startsWith('dev-placeholder-'),
    callback_url: `${POSTBACK_BASE_URL}/${row.network}`,
    updated_at: toIso(row.updated_at),
  };
}

export async function listOfferwallProviders(): Promise<{ items: OfferwallProvider[] }> {
  const rows = await db
    .selectFrom('network_config')
    .select([
      'network',
      'secret_key',
      'allowed_ips',
      'currency_per_usd',
      'hold_hours',
      'high_value_threshold_usd',
      'high_value_hold_hours',
      'credit_immediately',
      'is_active',
      'shadow_mode',
      'display_name',
      'icon_url',
      'placement',
      'updated_at',
    ])
    .where('network', 'in', OFFERWALL_PROVIDERS)
    .orderBy('network', 'asc')
    .execute();
  return { items: rows.map(serializeProvider) };
}

export async function updateOfferwallProvider(
  provider: string,
  actor: OfferwallAdminActor,
  patch: UpdateOfferwallProviderBody,
  ip: string,
): Promise<OfferwallProvider> {
  assertSupportedProvider(provider);
  if (patch.placement !== undefined && envPlacement(provider)) {
    throw new AppError(
      'PLACEMENT_ENV_OVERRIDE',
      'Placement is controlled by the deployment environment',
      409,
    );
  }
  if (patch.allowed_ips) {
    for (const cidr of patch.allowed_ips) {
      try {
        ipaddr.parseCIDR(cidr);
      } catch {
        throw new AppError('INVALID_CIDR', `Invalid callback CIDR: ${cidr}`, 400);
      }
    }
  }

  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('network_config')
      .selectAll()
      .where('network', '=', provider)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError('OFFERWALL_PROVIDER_NOT_FOUND', 'Provider not found', 404);
    const nextHoldHours = patch.hold_hours ?? before.hold_hours;
    const nextHighValueHoldHours = patch.high_value_hold_hours ?? before.high_value_hold_hours;
    if (nextHighValueHoldHours < nextHoldHours) {
      throw new AppError(
        'INVALID_HOLD_POLICY',
        'High-value hold hours must be greater than or equal to standard hold hours',
        400,
      );
    }
    await trx
      .updateTable('network_config')
      .set({
        ...(patch.display_name !== undefined ? { display_name: patch.display_name } : {}),
        ...(patch.icon_url !== undefined ? { icon_url: patch.icon_url } : {}),
        ...(patch.placement !== undefined ? { placement: patch.placement } : {}),
        ...(patch.allowed_ips !== undefined ? { allowed_ips: patch.allowed_ips } : {}),
        ...(patch.currency_per_usd !== undefined
          ? { currency_per_usd: patch.currency_per_usd }
          : {}),
        ...(patch.hold_hours !== undefined ? { hold_hours: patch.hold_hours } : {}),
        ...(patch.high_value_threshold_usd !== undefined
          ? { high_value_threshold_usd: patch.high_value_threshold_usd }
          : {}),
        ...(patch.high_value_hold_hours !== undefined
          ? { high_value_hold_hours: patch.high_value_hold_hours }
          : {}),
        ...(patch.credit_immediately !== undefined
          ? { credit_immediately: patch.credit_immediately }
          : {}),
        ...(patch.is_active !== undefined ? { is_active: patch.is_active } : {}),
        ...(patch.shadow_mode !== undefined ? { shadow_mode: patch.shadow_mode } : {}),
        updated_at: new Date(),
      })
      .where('network', '=', provider)
      .execute();
    await insertAudit(
      trx,
      actor,
      'OFFERWALL_PROVIDER_UPDATED',
      'network_config',
      null,
      {
        provider,
        before: serializeProvider(before),
        patch,
      },
      ip,
    );
  });

  const providers = await listOfferwallProviders();
  const updated = providers.items.find((item) => item.provider === provider);
  if (!updated) throw new AppError('OFFERWALL_PROVIDER_NOT_FOUND', 'Provider not found', 404);
  return updated;
}

function readShares(value: unknown): OfferwallRegionSettings['shares'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_SHARES };
  const record = value as Record<string, unknown>;
  return {
    '0': typeof record['0'] === 'number' ? record['0'] : DEFAULT_SHARES['0'],
    '1': typeof record['1'] === 'number' ? record['1'] : DEFAULT_SHARES['1'],
    '2': typeof record['2'] === 'number' ? record['2'] : DEFAULT_SHARES['2'],
    '3': typeof record['3'] === 'number' ? record['3'] : DEFAULT_SHARES['3'],
  };
}

function serializeRegionSettings(row: {
  region_id: string;
  features: unknown;
  updated_at: Date | string;
}): OfferwallRegionSettings {
  const features =
    row.features && typeof row.features === 'object' && !Array.isArray(row.features)
      ? (row.features as Record<string, unknown>)
      : {};
  const offerwall =
    features['offerwall'] &&
    typeof features['offerwall'] === 'object' &&
    !Array.isArray(features['offerwall'])
      ? (features['offerwall'] as StoredOfferwallFeature)
      : {};
  return {
    region_id: row.region_id,
    enabled: offerwall.enabled === true,
    networks: Array.isArray(offerwall.networks)
      ? offerwall.networks.filter((value): value is string => typeof value === 'string')
      : [],
    shares: readShares(offerwall.shares),
    updated_at: toIso(row.updated_at),
  };
}

export async function listOfferwallRegionSettings(): Promise<{
  items: OfferwallRegionSettings[];
}> {
  const rows = await db
    .selectFrom('region_config')
    .select(['region_id', 'features', 'updated_at'])
    .orderBy('region_id', 'asc')
    .execute();
  return { items: rows.map(serializeRegionSettings) };
}

export async function getOfferwallRegionSettings(
  regionId: string,
): Promise<OfferwallRegionSettings> {
  const row = await db
    .selectFrom('region_config')
    .select(['region_id', 'features', 'updated_at'])
    .where('region_id', '=', regionId)
    .executeTakeFirst();
  if (!row) throw new AppError('CONFIG_NOT_FOUND', 'Region config not found', 404);
  return serializeRegionSettings(row);
}

export async function updateOfferwallRegionSettings(
  regionId: string,
  actor: OfferwallAdminActor,
  patch: UpdateOfferwallRegionSettingsBody,
  ip: string,
): Promise<OfferwallRegionSettings> {
  if (patch.networks) {
    if (new Set(patch.networks).size !== patch.networks.length) {
      throw new AppError('INVALID_NETWORKS', 'networks must not contain duplicates', 400);
    }
    if (
      !patch.networks.every((provider) =>
        OFFERWALL_PROVIDERS.includes(provider as OfferwallProviderId),
      )
    ) {
      throw new AppError('INVALID_NETWORKS', 'Only Tapjoy and PubScale are supported', 400);
    }
    const known = await db
      .selectFrom('network_config')
      .select('network')
      .where('network', 'in', patch.networks)
      .execute();
    if (known.length !== patch.networks.length) {
      throw new AppError('INVALID_NETWORKS', 'One or more providers do not exist', 400);
    }
  }

  await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('region_config')
      .selectAll()
      .where('region_id', '=', regionId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError('CONFIG_NOT_FOUND', 'Region config not found', 404);
    const features =
      before.features && typeof before.features === 'object' && !Array.isArray(before.features)
        ? (before.features as Record<string, unknown>)
        : {};
    const previous = serializeRegionSettings(before);
    const offerwall = {
      ...((features['offerwall'] as Record<string, unknown> | undefined) ?? {}),
      enabled: patch.enabled ?? previous.enabled,
      networks: patch.networks ?? previous.networks,
      shares: patch.shares ?? previous.shares,
    };
    await trx
      .updateTable('region_config')
      .set({ features: JSON.stringify({ ...features, offerwall }), updated_at: new Date() })
      .where('region_id', '=', regionId)
      .execute();
    await insertAudit(
      trx,
      actor,
      'OFFERWALL_REGION_SETTINGS_UPDATED',
      'region_config',
      null,
      { region_id: regionId, before: previous, patch },
      ip,
    );
  });
  await invalidateConfigCache();
  return getOfferwallRegionSettings(regionId);
}
