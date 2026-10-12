import type { Transaction } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import type {
  BulkApproveBody,
  CatalogAdminListQuery,
  CatalogItemResponse,
  CatalogListResponse,
  CatalogStagingListQuery,
  CatalogStagingResponse,
  CreateCatalogItemBody,
  PublicCatalogItem,
  UpdateCatalogItemBody,
} from './schemas.js';

const FULFILLMENT_ROLES = ['fulfillment', 'superadmin'] as const;

interface AdminActor {
  id: string;
  role: string;
}

interface CatalogItemRow {
  id: string;
  sku: string;
  title: string;
  category: string;
  face_value: string;
  usd_cost: string;
  coin_price: string;
  image_url: string | null;
  seagm_url: string | null;
  regions: string[];
  is_active: boolean;
  stock_note: string | null;
  source: string;
  updated_at: Date;
}

interface CatalogStagingRow {
  id: string;
  sku: string;
  payload: unknown;
  diff: unknown;
  crawl_run_id: string;
  status: string;
  created_at: Date;
}

// Explicit serialization rather than passing Kysely rows straight through, matching
// redemption.service.ts's serializeRedemption — Dates and numerics need deliberate shaping to satisfy
// the TypeBox response schemas.
function serializeCatalogItem(row: CatalogItemRow): CatalogItemResponse {
  return {
    id: row.id,
    sku: row.sku,
    title: row.title,
    category: row.category,
    face_value: row.face_value,
    usd_cost: row.usd_cost,
    coin_price: row.coin_price,
    image_url: row.image_url,
    seagm_url: row.seagm_url,
    regions: row.regions,
    is_active: row.is_active,
    stock_note: row.stock_note,
    source: row.source,
    updated_at: row.updated_at.toISOString(),
  };
}

function serializeStaging(row: CatalogStagingRow): CatalogStagingResponse {
  return {
    id: row.id,
    sku: row.sku,
    payload: row.payload,
    diff: row.diff,
    crawl_run_id: row.crawl_run_id,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

export function assertFulfillmentRole(actor: AdminActor): void {
  if (!FULFILLMENT_ROLES.includes(actor.role as (typeof FULFILLMENT_ROLES)[number])) {
    throw new AppError('FORBIDDEN', 'Forbidden', 403);
  }
}

async function insertAudit(
  trx: Transaction<DB>,
  params: {
    adminUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    detail: unknown;
  },
): Promise<void> {
  await trx
    .insertInto('audit_log')
    .values({
      id: uuidv7(),
      admin_user_id: params.adminUserId,
      action: params.action,
      target_type: params.targetType,
      target_id: params.targetId,
      detail: JSON.stringify(params.detail),
      ip: null,
    })
    .execute();
}

// Display names for the category slugs stored in catalog_items.category. Kept in code rather than a
// table because these are UI labels for a closed set the crawler already constrains; an unknown slug
// falls back to a title-cased version of itself rather than dropping the item from the response.
const CATEGORY_NAMES: Record<string, string> = {
  gift_card: 'Gift Cards',
  game_card: 'Game Cards',
  paypal: 'PayPal',
  telco: 'Mobile Top-up',
};

function categoryNameFor(slug: string): string {
  return (
    CATEGORY_NAMES[slug] ??
    slug
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  );
}

function serializePublicItem(row: CatalogItemRow): PublicCatalogItem {
  return {
    id: row.id,
    sku: row.sku,
    title: row.title,
    category_id: row.category,
    subtitle: row.face_value,
    coin_price: row.coin_price,
    image_url: row.image_url,
    // Every row reaching here already passed the is_active + region filter, so `available` is true
    // today. It exists as a field so a future "temporarily out of stock" state has somewhere to go
    // without the app having to re-infer availability from an item's absence.
    available: true,
    stock_note: row.stock_note,
  };
}

// Public: active items available to the caller's region — small catalog (~30-80 items), filtering the
// region array in JS after one indexed query is simpler than raw SQL array-containment syntax and
// matches the same regions.includes(...) check redemption.service.ts already uses.
export async function listCatalog(
  regionId: string,
  countryCode: string,
): Promise<CatalogListResponse> {
  const rows = await db
    .selectFrom('catalog_items')
    .selectAll()
    .where('is_active', '=', true)
    .orderBy('id', 'desc')
    .execute();
  const visible = rows.filter(
    (row) => row.regions.includes(regionId) || row.regions.includes(countryCode),
  );

  // Derived from what is actually returned, not from a fixed list: a category the caller's region has
  // no items in must not appear as an empty tab in the app.
  const categories = [...new Set(visible.map((row) => row.category))].map((slug) => ({
    id: slug,
    name: categoryNameFor(slug),
  }));

  return { categories, items: visible.map(serializePublicItem) };
}

export async function listCatalogItemsAdmin(
  query: CatalogAdminListQuery,
): Promise<{ items: CatalogItemResponse[]; next_cursor: string | null }> {
  const limit = query.limit ?? 50;
  let builder = db
    .selectFrom('catalog_items')
    .selectAll()
    .orderBy('id', 'desc')
    .limit(limit + 1);
  if (query.is_active !== undefined) builder = builder.where('is_active', '=', query.is_active);
  if (query.cursor) builder = builder.where('id', '<', query.cursor);
  const rows = await builder.execute();
  const page = rows.slice(0, limit);
  return {
    items: page.map(serializeCatalogItem),
    next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function createCatalogItem(
  actor: AdminActor,
  body: CreateCatalogItemBody,
): Promise<CatalogItemResponse> {
  assertFulfillmentRole(actor);
  const id = uuidv7();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('catalog_items')
      .values({
        id,
        sku: body.sku,
        title: body.title,
        category: body.category,
        face_value: body.face_value,
        usd_cost: body.usd_cost.toString(),
        coin_price: body.coin_price,
        image_url: body.image_url ?? null,
        seagm_url: body.seagm_url ?? null,
        regions: body.regions,
        is_active: body.is_active ?? false,
        stock_note: body.stock_note ?? null,
        source: 'manual',
      })
      .execute();
    await insertAudit(trx, {
      adminUserId: actor.id,
      action: 'CATALOG_ITEM_CREATED',
      targetType: 'catalog_item',
      targetId: id,
      detail: { sku: body.sku },
    });
  });
  const created = await db
    .selectFrom('catalog_items')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return serializeCatalogItem(created);
}

export async function updateCatalogItem(
  id: string,
  actor: AdminActor,
  patch: UpdateCatalogItemBody,
): Promise<CatalogItemResponse> {
  assertFulfillmentRole(actor);
  await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('catalog_items')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!existing) {
      throw new AppError('CATALOG_ITEM_NOT_FOUND', 'Catalog item not found', 404);
    }
    await trx
      .updateTable('catalog_items')
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.face_value !== undefined ? { face_value: patch.face_value } : {}),
        ...(patch.usd_cost !== undefined ? { usd_cost: patch.usd_cost.toString() } : {}),
        ...(patch.coin_price !== undefined ? { coin_price: patch.coin_price } : {}),
        ...(patch.image_url !== undefined ? { image_url: patch.image_url } : {}),
        ...(patch.seagm_url !== undefined ? { seagm_url: patch.seagm_url } : {}),
        ...(patch.regions !== undefined ? { regions: patch.regions } : {}),
        ...(patch.is_active !== undefined ? { is_active: patch.is_active } : {}),
        ...(patch.stock_note !== undefined ? { stock_note: patch.stock_note } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    await insertAudit(trx, {
      adminUserId: actor.id,
      action: 'CATALOG_ITEM_UPDATED',
      targetType: 'catalog_item',
      targetId: id,
      detail: patch,
    });
  });
  const updated = await db
    .selectFrom('catalog_items')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return serializeCatalogItem(updated);
}

export async function listCatalogStaging(
  query: CatalogStagingListQuery,
): Promise<{ items: CatalogStagingResponse[]; next_cursor: string | null }> {
  const limit = query.limit ?? 50;
  let builder = db
    .selectFrom('catalog_staging')
    .selectAll()
    .orderBy('id', 'desc')
    .limit(limit + 1);
  if (query.status) builder = builder.where('status', '=', query.status);
  if (query.cursor) builder = builder.where('id', '<', query.cursor);
  const rows = await builder.execute();
  const page = rows.slice(0, limit);
  return {
    items: page.map(serializeStaging),
    next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

interface StagingDiffShape {
  needs_attention?: boolean;
}

// catalog_staging.payload is JSONB (typed `unknown`) written by the crawler, so every field is read
// defensively rather than cast — a malformed payload must not put garbage like "[object Object]"
// into the live catalog.
function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNumeric(value: unknown): string | null {
  const asNumber = readNumber(value);
  if (asNumber !== null) return asNumber.toString();
  return readString(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

async function approveStagingRow(
  trx: Transaction<DB>,
  stagingId: string,
  actor: AdminActor,
): Promise<void> {
  const staging = await trx
    .selectFrom('catalog_staging')
    .selectAll()
    .where('id', '=', stagingId)
    .where('status', '=', 'pending')
    .forUpdate()
    .executeTakeFirst();
  if (!staging) {
    throw new AppError(
      'CATALOG_STAGING_NOT_FOUND',
      'Staging entry not found or already resolved',
      404,
    );
  }

  const payload = (staging.payload ?? {}) as Record<string, unknown>;
  await trx
    .insertInto('catalog_items')
    .values({
      id: uuidv7(),
      sku: staging.sku,
      title: readString(payload['title']) ?? staging.sku,
      category: readString(payload['category']) ?? 'gift_card',
      face_value: readString(payload['face_value']) ?? '',
      usd_cost: readNumeric(payload['usd_cost']) ?? '0',
      coin_price: readNumber(payload['coin_price']) ?? 0,
      image_url: null,
      seagm_url: readString(payload['seagm_url']),
      regions: readStringArray(payload['regions']),
      is_active: true,
      stock_note: null,
      source: 'crawler',
    })
    .onConflict((oc) =>
      oc.column('sku').doUpdateSet({
        title: (eb) => eb.ref('excluded.title'),
        usd_cost: (eb) => eb.ref('excluded.usd_cost'),
        coin_price: (eb) => eb.ref('excluded.coin_price'),
        seagm_url: (eb) => eb.ref('excluded.seagm_url'),
        updated_at: new Date(),
      }),
    )
    .execute();

  await trx
    .updateTable('catalog_staging')
    .set({ status: 'approved' })
    .where('id', '=', stagingId)
    .execute();
  await insertAudit(trx, {
    adminUserId: actor.id,
    action: 'CATALOG_STAGING_APPROVED',
    targetType: 'catalog_staging',
    targetId: stagingId,
    detail: { sku: staging.sku },
  });
}

export async function approveCatalogStaging(stagingId: string, actor: AdminActor): Promise<void> {
  assertFulfillmentRole(actor);
  await db.transaction().execute((trx) => approveStagingRow(trx, stagingId, actor));
}

export async function ignoreCatalogStaging(stagingId: string, actor: AdminActor): Promise<void> {
  assertFulfillmentRole(actor);
  await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('catalog_staging')
      .set({ status: 'ignored' })
      .where('id', '=', stagingId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      throw new AppError(
        'CATALOG_STAGING_NOT_FOUND',
        'Staging entry not found or already resolved',
        404,
      );
    }
    await insertAudit(trx, {
      adminUserId: actor.id,
      action: 'CATALOG_STAGING_IGNORED',
      targetType: 'catalog_staging',
      targetId: stagingId,
      detail: {},
    });
  });
}

// 07-CATALOG-CRAWLER.md §5: bulk-approve only the "green" diffs — rows flagged needs_attention (>20%
// price change) require individual review via approveCatalogStaging instead, so they're skipped here
// rather than rejected outright.
export async function bulkApproveCatalogStaging(
  actor: AdminActor,
  body: BulkApproveBody,
): Promise<{ approved: string[]; skipped: string[] }> {
  assertFulfillmentRole(actor);
  const approved: string[] = [];
  const skipped: string[] = [];

  for (const stagingId of body.staging_ids) {
    const staging = await db
      .selectFrom('catalog_staging')
      .select(['id', 'diff', 'status'])
      .where('id', '=', stagingId)
      .executeTakeFirst();
    if (staging?.status !== 'pending') {
      skipped.push(stagingId);
      continue;
    }
    const diff = staging.diff as StagingDiffShape | null;
    if (diff?.needs_attention) {
      skipped.push(stagingId);
      continue;
    }
    await db.transaction().execute((trx) => approveStagingRow(trx, stagingId, actor));
    approved.push(stagingId);
  }

  return { approved, skipped };
}
