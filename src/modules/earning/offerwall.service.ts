import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import type { OfferwallOffersResponse } from './offerwall-schemas.js';
import { env } from '../../config/env.js';
import { sql } from 'kysely';

// The `offers` returned here are CMS-managed launch cards, not individual partner tasks. Tapjoy and
// PubScale still render and attribute their own task catalogs inside their Android SDKs. `networks`
// remains as a compatibility field for older clients.
//
// Display metadata comes from network_config (migration 39) rather than a map in this file, so an
// admin can fix a logo or repoint a placement without a release. Any of it may be NULL while the real
// values are still unknown; the app falls back to its bundled asset. `deeplink_url` is retained as a
// nullable field for one release so the existing client does not break on a missing key — there is no
// URL to navigate to and there never was.

interface OfferwallFeature {
  enabled?: boolean;
  networks?: unknown;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
}

function placementFor(network: string, databasePlacement: string | null): string | null {
  if (network === 'tapjoy') return nonEmpty(env.TAPJOY_PLACEMENT) ?? databasePlacement;
  if (network === 'pubscale') return nonEmpty(env.PUBSCALE_PLACEMENT) ?? databasePlacement;
  return databasePlacement;
}

export async function getOfferwallOffers(regionId: string): Promise<OfferwallOffersResponse> {
  const row = await db
    .selectFrom('region_config')
    .select(['features'])
    .where('region_id', '=', regionId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError('CONFIG_NOT_FOUND', 'Region config not found', 500);
  }

  const features = row.features as Record<string, unknown>;
  const offerwall = (features['offerwall'] as OfferwallFeature | undefined) ?? {};

  if (!offerwall.enabled) {
    return { enabled: false, offers: [], networks: [] };
  }

  const networkIds: string[] = Array.isArray(offerwall.networks)
    ? (offerwall.networks as string[])
    : [];

  if (networkIds.length === 0) {
    return { enabled: true, offers: [], networks: [] };
  }

  const configured = await db
    .selectFrom('network_config')
    .select(['network', 'display_name', 'icon_url', 'placement'])
    .where('network', 'in', networkIds)
    .where('is_active', '=', true)
    .execute();
  const byId = new Map(configured.map((config) => [config.network, config]));

  // A region can list a network that has no active network_config row (migration 29 hit exactly this
  // with 'adgate'). Dropping it beats rendering a tile that cannot open anything.
  const networks = networkIds
    .filter((id) => byId.has(id))
    .map((id) => {
      const config = byId.get(id);
      return {
        id,
        name: config?.display_name ?? id,
        icon_url: config?.icon_url ?? null,
        placement: placementFor(id, config?.placement ?? null),
        deeplink_url: null,
      };
    });

  const now = new Date();
  const offerRows = await db
    .selectFrom('offerwall_offers')
    .selectAll()
    .where('status', '=', 'active')
    .where('provider', 'in', networkIds)
    .where(sql<boolean>`${regionId} = ANY(region_ids)`)
    .where((eb) => eb.or([eb('starts_at', 'is', null), eb('starts_at', '<=', now)]))
    .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)]))
    .orderBy('sort_order', 'asc')
    .orderBy('code', 'asc')
    .execute();

  const offers = offerRows.flatMap((offer) => {
    const provider = byId.get(offer.provider);
    if (!provider) return [];
    return [
      {
        id: offer.code,
        provider: offer.provider,
        name: offer.name,
        description: offer.description,
        icon_url: offer.icon_url ?? provider.icon_url,
        badge_text: offer.badge_text,
        placement: offer.placement ?? placementFor(offer.provider, provider.placement),
      },
    ];
  });

  return { enabled: true, offers, networks };
}
