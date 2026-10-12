import { uuidv7 } from 'uuidv7';
import { Queue, Worker, type Job } from 'bullmq';
import type pino from 'pino';
import { queueRedis } from '../redis/index.js';
import { db } from '../db/index.js';
import { computeDiff, type CatalogDiff } from '../modules/catalog/diff.js';
import { noopCatalogSource, type CatalogSource } from '../modules/catalog/catalog-source.js';

export const QUEUE_NAME = 'catalog-crawler';

export function createCatalogCrawlerQueue(): Queue {
  return new Queue(QUEUE_NAME, { connection: queueRedis });
}

// 07-CATALOG-CRAWLER.md §1: "Tần suất thấp: 1-2 run/ngày (cron 06:00 & 18:00 giờ VN)."
export async function scheduleCatalogCrawlerRepeat(queue: Queue): Promise<void> {
  await queue.add(
    'crawl',
    {},
    { repeat: { pattern: '0 6,18 * * *', tz: 'Asia/Ho_Chi_Minh' }, jobId: 'catalog-crawler-run' },
  );
}

interface FxRateRow {
  rate: string;
}

async function getMyrUsdRate(): Promise<number> {
  const row = (await db
    .selectFrom('fx_rates')
    .select('rate')
    .where('currency_pair', '=', 'MYR_USD')
    .executeTakeFirst()) as FxRateRow | undefined;
  return row ? Number(row.rate) : 0;
}

async function priorStockOutStreak(sku: string): Promise<number> {
  const previous = await db
    .selectFrom('catalog_staging')
    .select('diff')
    .where('sku', '=', sku)
    // uuidv7 ids are time-sortable, so id ordering doubles as chronological without the ambiguity
    // two rows sharing a created_at timestamp would introduce (same convention as wallet ledger).
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const diff = previous?.diff as { stock_out_streak?: number } | null;
  return diff?.stock_out_streak ?? 0;
}

// Never auto-publishes to catalog_items except the one guardrail 07-CATALOG-CRAWLER.md §3 explicitly
// allows to touch live catalog automatically: deactivating an item whose new cost already exceeds
// what we're charging for it. Everything else lands in catalog_staging for admin review.
export async function processCatalogCrawlerRun(
  logger: pino.Logger,
  source: CatalogSource,
): Promise<void> {
  const catalogRows = await db
    .selectFrom('catalog_items')
    .select(['id', 'sku', 'coin_price', 'usd_cost', 'is_active'])
    .where('seagm_url', 'is not', null)
    .execute();
  if (catalogRows.length === 0) {
    logger.info('catalog crawler: no whitelisted SKUs to crawl');
    return;
  }

  const items = await source.fetch(catalogRows.map((row) => row.sku));
  if (items === null) {
    logger.info('catalog crawler: no source configured, skipped');
    return;
  }

  const fxRate = await getMyrUsdRate();
  const crawlRunId = uuidv7();
  const bySku = new Map(catalogRows.map((row) => [row.sku, row]));

  for (const normalized of items) {
    const current = bySku.get(normalized.sku);
    const streak = await priorStockOutStreak(normalized.sku);
    const diff: CatalogDiff = computeDiff(
      current
        ? {
            sku: current.sku,
            coin_price: Number(current.coin_price),
            usd_cost: Number(current.usd_cost),
            is_active: current.is_active,
          }
        : undefined,
      normalized,
      fxRate,
      streak,
    );

    await db
      .insertInto('catalog_staging')
      .values({
        id: uuidv7(),
        sku: normalized.sku,
        payload: JSON.stringify({
          title: normalized.title,
          category: normalized.category,
          face_value: normalized.face_value,
          usd_cost: diff.new_usd_cost,
          coin_price: diff.new_coin_price,
          seagm_url: normalized.seagm_url,
          regions: current ? undefined : [normalized.region_of_card],
          in_stock: normalized.in_stock,
        }),
        diff: JSON.stringify(diff),
        crawl_run_id: crawlRunId,
        status: 'pending',
      })
      .execute();

    if (diff.auto_deactivate && current) {
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('catalog_items')
          .set({ is_active: false, updated_at: new Date() })
          .where('id', '=', current.id)
          .execute();
        await trx
          .insertInto('audit_log')
          .values({
            id: uuidv7(),
            admin_user_id: null,
            action: 'CATALOG_AUTO_DEACTIVATED',
            target_type: 'catalog_item',
            target_id: current.id,
            detail: JSON.stringify(diff),
            ip: null,
          })
          .execute();
      });
      logger.warn(
        { sku: normalized.sku, diff },
        'catalog item auto-deactivated: cost exceeds price',
      );
    }
  }

  logger.info({ crawlRunId, count: items.length }, 'catalog crawler run complete');
}

export function createCatalogCrawlerWorker(
  logger: pino.Logger,
  source: CatalogSource = noopCatalogSource,
): Worker {
  return new Worker(
    QUEUE_NAME,
    async (_job: Job) => {
      await processCatalogCrawlerRun(logger, source);
    },
    { connection: queueRedis },
  );
}
