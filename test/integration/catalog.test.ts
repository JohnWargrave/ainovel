import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import pino from 'pino';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { processCatalogCrawlerRun } from '../../src/jobs/catalog-crawler.js';
import {
  noopCatalogSource,
  type CatalogSource,
  type NormalizedCatalogItem,
} from '../../src/modules/catalog/catalog-source.js';
import {
  computeCoinPrice,
  convertMyrToUsd,
  listedUsdValue,
} from '../../src/modules/catalog/pricing.js';

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};
const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

// Matches the fx_rates seed (1700000000025) — MYR->USD with the 1% safety margin baked into
// convertMyrToUsd.
const FX_RATE = 0.21;

interface ErrorResponseBody {
  error: { code: string; message: string };
}

interface CatalogItemBody {
  id: string;
  sku: string;
  coin_price: string;
  usd_cost: string;
  is_active: boolean;
  regions: string[];
}

// The public shape, deliberately narrower than CatalogItemBody (the admin one) — see
// PublicCatalogItemSchema.
interface PublicCatalogItemBody {
  id: string;
  sku: string;
  title: string;
  category_id: string;
  subtitle: string;
  coin_price: string;
  image_url: string | null;
  available: boolean;
  stock_note: string | null;
}

interface CatalogListBody {
  categories: { id: string; name: string }[];
  items: PublicCatalogItemBody[];
}

interface StagingListBody {
  items: { id: string; sku: string; status: string; diff: Record<string, unknown> }[];
}

interface BulkApproveBody {
  approved: string[];
  skipped: string[];
}

const silentLogger = pino({ level: 'silent' });

function adminHeaders(adminUserId: string, withCsrf = true): Record<string, string> {
  return {
    'x-admin-api-key': ADMIN_API_KEY,
    'x-admin-user-id': adminUserId,
    ...(withCsrf ? { 'x-csrf-token': ADMIN_CSRF_TOKEN } : {}),
  };
}

async function createAdminUser(role: string): Promise<string> {
  const adminId = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id: adminId, email: `admin-${randomUUID()}@test.local`, role })
    .execute();
  return adminId;
}

async function insertCatalogItem(overrides?: {
  sku?: string;
  coinPrice?: number;
  usdCost?: number;
  isActive?: boolean;
  regions?: string[];
  seagmUrl?: string | null;
}): Promise<{ id: string; sku: string }> {
  const id = uuidv7();
  const sku = overrides?.sku ?? `seagm-test-${randomUUID()}`;
  await db
    .insertInto('catalog_items')
    .values({
      id,
      sku,
      title: 'Test Gift Card',
      category: 'gift_card',
      face_value: '$10',
      usd_cost: String(overrides?.usdCost ?? 10),
      coin_price: overrides?.coinPrice ?? 108_000,
      image_url: null,
      seagm_url:
        overrides?.seagmUrl === undefined ? 'https://seagm.example/item' : overrides.seagmUrl,
      regions: overrides?.regions ?? ['XX'],
      is_active: overrides?.isActive ?? true,
      stock_note: null,
      source: 'crawler',
    })
    .execute();
  return { id, sku };
}

function normalizedItem(
  sku: string,
  overrides?: { myrAmount?: number; inStock?: boolean },
): NormalizedCatalogItem {
  return {
    sku,
    title: 'Test Gift Card',
    category: 'gift_card',
    face_value: '$10',
    seagm_price_raw: { amount: overrides?.myrAmount ?? 47.2, currency: 'MYR' },
    seagm_url: 'https://seagm.example/item',
    region_of_card: 'US',
    in_stock: overrides?.inStock ?? true,
  };
}

function sourceReturning(items: NormalizedCatalogItem[]): CatalogSource {
  // Only answers for SKUs the crawler actually asked about, mirroring how a real source would only
  // return what it was told to look up.
  return {
    fetch: (skus: string[]): Promise<NormalizedCatalogItem[] | null> =>
      Promise.resolve(items.filter((item) => skus.includes(item.sku))),
  };
}

async function stagingFor(sku: string): Promise<{ id: string; diff: Record<string, unknown> }[]> {
  const rows = await db
    .selectFrom('catalog_staging')
    .select(['id', 'diff'])
    .where('sku', '=', sku)
    .orderBy('id', 'desc')
    .execute();
  return rows.map((row) => ({ id: row.id, diff: row.diff as Record<string, unknown> }));
}

describe('catalog crawler', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('pricing', () => {
    it('applies the 1% FX safety margin on MYR -> USD', () => {
      expect(convertMyrToUsd(100, 0.21)).toBeCloseTo(21.21, 6);
      expect(convertMyrToUsd(47.2, 0.21)).toBeCloseTo(10.01112, 6);
    });

    it('rounds the coin price up to the nearest 100 with an 8% buffer', () => {
      expect(computeCoinPrice(10)).toBe(108_000);
      // 10.005 * 1.08 * 10000 / 100 = 1080.54 -> ceil 1081 -> 108100
      expect(computeCoinPrice(10.005)).toBe(108_100);
    });

    it('converts a listed coin price back to its USD anchor', () => {
      expect(listedUsdValue(108_000)).toBeCloseTo(10.8, 6);
    });
  });

  describe('crawl run', () => {
    it('writes nothing when no source is configured', async () => {
      const { sku } = await insertCatalogItem();

      await processCatalogCrawlerRun(silentLogger, noopCatalogSource);

      expect(await stagingFor(sku)).toHaveLength(0);
    });

    it('skips SKUs without a seagm_url', async () => {
      const { sku } = await insertCatalogItem({ seagmUrl: null });

      await processCatalogCrawlerRun(silentLogger, sourceReturning([normalizedItem(sku)]));

      expect(await stagingFor(sku)).toHaveLength(0);
    });

    it('stages a small price change without flagging it for attention', async () => {
      // 47.2 MYR -> 10.01112 USD -> 108,200 coin, a ~0.19% move off the 108,000 baseline.
      const { sku } = await insertCatalogItem({ coinPrice: 108_000, usdCost: 10 });

      await processCatalogCrawlerRun(silentLogger, sourceReturning([normalizedItem(sku)]));

      const staging = await stagingFor(sku);
      expect(staging).toHaveLength(1);
      expect(staging[0]?.diff['needs_attention']).toBe(false);
      expect(staging[0]?.diff['auto_deactivate']).toBe(false);
      expect(staging[0]?.diff['new_coin_price']).toBe(108_200);
      expect(staging[0]?.diff['previous_coin_price']).toBe(108_000);
    });

    it('flags a >20% price move as needs_attention without deactivating', async () => {
      // 60 MYR -> 12.726 USD -> 137,500 coin, a -31% move off the 200,000 baseline. Still below the
      // 20 USD the listed price represents, so the auto-deactivate guardrail must stay off.
      const { sku } = await insertCatalogItem({ coinPrice: 200_000, usdCost: 10 });

      await processCatalogCrawlerRun(
        silentLogger,
        sourceReturning([normalizedItem(sku, { myrAmount: 60 })]),
      );

      const staging = await stagingFor(sku);
      expect(staging[0]?.diff['needs_attention']).toBe(true);
      expect(staging[0]?.diff['auto_deactivate']).toBe(false);

      const item = await db
        .selectFrom('catalog_items')
        .select('is_active')
        .where('sku', '=', sku)
        .executeTakeFirstOrThrow();
      expect(item.is_active).toBe(true);
    });

    it('auto-deactivates when the new cost exceeds the listed price and writes an audit row', async () => {
      // 60 MYR -> 12.726 USD, above the 10 USD that 100,000 coin represents.
      const item = await insertCatalogItem({ coinPrice: 100_000, usdCost: 10, isActive: true });

      await processCatalogCrawlerRun(
        silentLogger,
        sourceReturning([normalizedItem(item.sku, { myrAmount: 60 })]),
      );

      const updated = await db
        .selectFrom('catalog_items')
        .select('is_active')
        .where('sku', '=', item.sku)
        .executeTakeFirstOrThrow();
      expect(updated.is_active).toBe(false);

      // The staging row is still written — auto-deactivate protects revenue, it doesn't replace the
      // admin's review of the new price.
      expect(await stagingFor(item.sku)).toHaveLength(1);

      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'CATALOG_AUTO_DEACTIVATED')
        .where('target_id', '=', item.id)
        .execute();
      expect(audit).toHaveLength(1);
    });

    it('suggests deactivation only after two consecutive out-of-stock runs', async () => {
      const { sku } = await insertCatalogItem({ coinPrice: 108_000, usdCost: 10 });
      const outOfStock = sourceReturning([normalizedItem(sku, { inStock: false })]);

      await processCatalogCrawlerRun(silentLogger, outOfStock);
      let staging = await stagingFor(sku);
      expect(staging[0]?.diff['stock_out_streak']).toBe(1);
      expect(staging[0]?.diff['suggest_deactivate']).toBe(false);

      await processCatalogCrawlerRun(silentLogger, outOfStock);
      staging = await stagingFor(sku);
      expect(staging[0]?.diff['stock_out_streak']).toBe(2);
      expect(staging[0]?.diff['suggest_deactivate']).toBe(true);

      // Still live — a stock-out only ever produces a suggestion, never an automatic change.
      const item = await db
        .selectFrom('catalog_items')
        .select('is_active')
        .where('sku', '=', sku)
        .executeTakeFirstOrThrow();
      expect(item.is_active).toBe(true);
    });
  });

  describe('admin catalog', () => {
    it('creates, lists, and updates an item', async () => {
      const adminId = await createAdminUser('fulfillment');
      const sku = `manual-${randomUUID()}`;

      const created = await app.inject({
        method: 'POST',
        url: '/admin/catalog',
        headers: adminHeaders(adminId),
        payload: {
          sku,
          title: 'Manual Card',
          category: 'gift_card',
          face_value: '$5',
          usd_cost: 5,
          coin_price: 54_000,
          regions: ['VN'],
        },
      });
      expect(created.statusCode).toBe(200);
      const createdBody = created.json<CatalogItemBody>();
      expect(createdBody.sku).toBe(sku);
      expect(createdBody.is_active).toBe(false);

      const listed = await app.inject({
        method: 'GET',
        url: '/admin/catalog',
        headers: adminHeaders(adminId),
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ items: CatalogItemBody[] }>().items.some((i) => i.sku === sku)).toBe(
        true,
      );

      const updated = await app.inject({
        method: 'POST',
        url: `/admin/catalog/${createdBody.id}`,
        headers: adminHeaders(adminId),
        payload: { is_active: true, stock_note: 'restocked' },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json<CatalogItemBody>().is_active).toBe(true);
    });

    it('rejects a reviewer-only admin', async () => {
      const reviewerId = await createAdminUser('reviewer');

      const res = await app.inject({
        method: 'GET',
        url: '/admin/catalog',
        headers: adminHeaders(reviewerId),
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects a mutation without a CSRF token', async () => {
      const adminId = await createAdminUser('fulfillment');

      const res = await app.inject({
        method: 'POST',
        url: '/admin/catalog',
        headers: adminHeaders(adminId, false),
        payload: {
          sku: `manual-${randomUUID()}`,
          title: 'No CSRF',
          category: 'gift_card',
          face_value: '$5',
          usd_cost: 5,
          coin_price: 54_000,
          regions: ['VN'],
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<ErrorResponseBody>().error.code).toBe('CSRF_TOKEN_INVALID');
    });
  });

  describe('admin staging review', () => {
    it('merges an approved diff into the live catalog', async () => {
      const adminId = await createAdminUser('fulfillment');
      const { sku } = await insertCatalogItem({ coinPrice: 108_000, usdCost: 10 });
      await processCatalogCrawlerRun(silentLogger, sourceReturning([normalizedItem(sku)]));
      const [staging] = await stagingFor(sku);

      const res = await app.inject({
        method: 'POST',
        url: `/admin/catalog/staging/${staging?.id ?? ''}/approve`,
        headers: adminHeaders(adminId),
      });
      expect(res.statusCode).toBe(200);

      const item = await db
        .selectFrom('catalog_items')
        .select(['coin_price', 'usd_cost'])
        .where('sku', '=', sku)
        .executeTakeFirstOrThrow();
      expect(item.coin_price).toBe('108200');

      const row = await db
        .selectFrom('catalog_staging')
        .select('status')
        .where('id', '=', staging?.id ?? '')
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('approved');

      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'CATALOG_STAGING_APPROVED')
        .where('target_id', '=', staging?.id ?? '')
        .execute();
      expect(audit).toHaveLength(1);
    });

    it('ignores a diff without touching the live catalog', async () => {
      const adminId = await createAdminUser('fulfillment');
      const { sku } = await insertCatalogItem({ coinPrice: 108_000, usdCost: 10 });
      await processCatalogCrawlerRun(silentLogger, sourceReturning([normalizedItem(sku)]));
      const [staging] = await stagingFor(sku);

      const res = await app.inject({
        method: 'POST',
        url: `/admin/catalog/staging/${staging?.id ?? ''}/ignore`,
        headers: adminHeaders(adminId),
      });
      expect(res.statusCode).toBe(200);

      const row = await db
        .selectFrom('catalog_staging')
        .select('status')
        .where('id', '=', staging?.id ?? '')
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('ignored');

      const item = await db
        .selectFrom('catalog_items')
        .select('coin_price')
        .where('sku', '=', sku)
        .executeTakeFirstOrThrow();
      expect(item.coin_price).toBe('108000');
    });

    it('bulk-approve skips rows flagged needs_attention', async () => {
      const adminId = await createAdminUser('fulfillment');
      const green = await insertCatalogItem({ coinPrice: 108_000, usdCost: 10 });
      const red = await insertCatalogItem({ coinPrice: 200_000, usdCost: 10 });

      await processCatalogCrawlerRun(
        silentLogger,
        sourceReturning([normalizedItem(green.sku), normalizedItem(red.sku, { myrAmount: 60 })]),
      );
      const [greenStaging] = await stagingFor(green.sku);
      const [redStaging] = await stagingFor(red.sku);

      const res = await app.inject({
        method: 'POST',
        url: '/admin/catalog/staging/bulk-approve',
        headers: adminHeaders(adminId),
        payload: { staging_ids: [greenStaging?.id ?? '', redStaging?.id ?? ''] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<BulkApproveBody>();
      expect(body.approved).toEqual([greenStaging?.id]);
      expect(body.skipped).toEqual([redStaging?.id]);

      const redRow = await db
        .selectFrom('catalog_staging')
        .select('status')
        .where('id', '=', redStaging?.id ?? '')
        .executeTakeFirstOrThrow();
      expect(redRow.status).toBe('pending');
    });

    it('lists staging entries filtered by status', async () => {
      const adminId = await createAdminUser('fulfillment');
      const { sku } = await insertCatalogItem({ coinPrice: 108_000, usdCost: 10 });
      await processCatalogCrawlerRun(silentLogger, sourceReturning([normalizedItem(sku)]));

      const res = await app.inject({
        method: 'GET',
        url: '/admin/catalog/staging?status=pending',
        headers: adminHeaders(adminId),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<StagingListBody>();
      expect(body.items.some((row) => row.sku === sku)).toBe(true);
      expect(body.items.every((row) => row.status === 'pending')).toBe(true);
    });
  });

  describe('public catalog', () => {
    it('returns only active items for the caller region', async () => {
      // catalog_items.regions is CHAR(2)[], so it holds country codes — resolveRegion() maps an
      // unresolvable loopback IP to countryCode 'XX', which is what app.inject requests look like.
      const visible = await insertCatalogItem({ isActive: true, regions: ['XX'] });
      const inactive = await insertCatalogItem({ isActive: false, regions: ['XX'] });
      const otherRegion = await insertCatalogItem({ isActive: true, regions: ['VN'] });

      const res = await app.inject({ method: 'GET', url: '/catalog', headers: APP_HEADERS });
      expect(res.statusCode).toBe(200);
      const skus = res.json<CatalogListBody>().items.map((item) => item.sku);
      expect(skus).toContain(visible.sku);
      expect(skus).not.toContain(inactive.sku);
      expect(skus).not.toContain(otherRegion.sku);
    });

    it('never exposes supplier cost or supplier links to unauthenticated callers', async () => {
      const item = await insertCatalogItem({
        isActive: true,
        regions: ['XX'],
        usdCost: 10,
        seagmUrl: 'https://seagm.example/secret-supplier-link',
      });

      const res = await app.inject({ method: 'GET', url: '/catalog', headers: APP_HEADERS });
      expect(res.statusCode).toBe(200);
      const found = res
        .json<CatalogListBody>()
        .items.find((candidate) => candidate.sku === item.sku);
      expect(found).toBeDefined();
      // usd_cost is our margin and seagm_url is the supplier deep link. This route has no auth guard,
      // so anyone could otherwise scrape our cost on every SKU.
      expect(found).not.toHaveProperty('usd_cost');
      expect(found).not.toHaveProperty('seagm_url');
      expect(found).not.toHaveProperty('source');
      // Whole-body check, not just this item — a leak anywhere in the payload is still a leak.
      expect(res.body).not.toContain('secret-supplier-link');
    });

    it('returns the app-facing field names and a category list', async () => {
      const item = await insertCatalogItem({ isActive: true, regions: ['XX'] });

      const res = await app.inject({ method: 'GET', url: '/catalog', headers: APP_HEADERS });
      const body = res.json<CatalogListBody>();
      const found = body.items.find((candidate) => candidate.sku === item.sku);
      expect(found).toMatchObject({
        title: 'Test Gift Card',
        category_id: 'gift_card', // from catalog_items.category
        subtitle: '$10', // from catalog_items.face_value
        available: true, // from is_active + region match
      });
      // Categories are derived from the items actually returned, so a category with no visible item
      // never shows up as an empty tab.
      expect(body.categories).toContainEqual({ id: 'gift_card', name: 'Gift Cards' });
    });

    it('requires app headers', async () => {
      const res = await app.inject({ method: 'GET', url: '/catalog' });
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorResponseBody>().error.code).toBe('VALIDATION_ERROR');
    });

    it('is exposed under the /v1 alias', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/catalog', headers: APP_HEADERS });
      expect(res.statusCode).toBe(200);
    });

    it('serves the seeded starter catalog', async () => {
      // Migration 36. Without it the Redeem screen is empty on a fresh deploy and the redemption
      // flow cannot be exercised at all.
      const res = await app.inject({ method: 'GET', url: '/catalog', headers: APP_HEADERS });
      const skus = res.json<CatalogListBody>().items.map((item) => item.sku);
      expect(skus).toContain('seagm-googleplay-us-5');
    });
  });

  it('keeps the seeded FX rate the pricing math assumes', async () => {
    const row = await db
      .selectFrom('fx_rates')
      .select('rate')
      .where('currency_pair', '=', 'MYR_USD')
      .executeTakeFirstOrThrow();
    expect(Number(row.rate)).toBeCloseTo(FX_RATE, 6);
  });
});
