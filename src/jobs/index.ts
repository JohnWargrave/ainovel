import type { Worker } from 'bullmq';
import type pino from 'pino';
import {
  createHoldReleaseQueue,
  createHoldReleaseWorker,
  scheduleHoldReleaseRepeat,
} from './hold-release.js';
import {
  createIpAllowlistRefreshQueue,
  createIpAllowlistRefreshWorker,
  scheduleIpAllowlistRefreshRepeat,
} from './ip-allowlist-refresh.js';
import { createPostbackFraudHookWorker } from './postback-fraud-hook.js';
import { createReferralCreditWorker } from './referral-credit.js';
import { createNovelImportWorker } from './novel-import.js';
import { createNovelCoverWorker } from './novel-cover.js';
import {
  createCatalogCrawlerQueue,
  createCatalogCrawlerWorker,
  scheduleCatalogCrawlerRepeat,
} from './catalog-crawler.js';
import {
  createEconomyBackingAlertQueue,
  createEconomyBackingAlertWorker,
  scheduleEconomyBackingAlertRepeat,
} from './economy-backing-alert.js';

export async function registerJobs(logger: pino.Logger): Promise<Worker[]> {
  const holdReleaseQueue = createHoldReleaseQueue();
  await scheduleHoldReleaseRepeat(holdReleaseQueue);
  const holdReleaseWorker = createHoldReleaseWorker(logger);

  const ipAllowlistRefreshQueue = createIpAllowlistRefreshQueue();
  await scheduleIpAllowlistRefreshRepeat(ipAllowlistRefreshQueue);
  const ipAllowlistRefreshWorker = createIpAllowlistRefreshWorker(logger);

  // Event-driven (enqueued by postback.service.ts per accepted credit/reversal) — no repeat
  // schedule to register, just the consumer.
  const postbackFraudHookWorker = createPostbackFraudHookWorker(logger);

  // Event-driven (enqueued by postback.service.ts / ssv.service.ts per accepted backed credit) — no
  // repeat schedule, just the consumer.
  const referralCreditWorker = createReferralCreditWorker(logger);

  // Event-driven (enqueued by the CMS import upload) — parses uploaded novel files.
  const novelImportWorker = createNovelImportWorker(logger);

  // Event-driven (enqueued by the CMS "Generate AI cover" button and by import commits).
  const novelCoverWorker = createNovelCoverWorker(logger);

  const catalogCrawlerQueue = createCatalogCrawlerQueue();
  await scheduleCatalogCrawlerRepeat(catalogCrawlerQueue);
  // Default source is noopCatalogSource until SeaGM ToS/reseller channel is confirmed — see
  // catalog-source.ts.
  const catalogCrawlerWorker = createCatalogCrawlerWorker(logger);

  const economyBackingAlertQueue = createEconomyBackingAlertQueue();
  await scheduleEconomyBackingAlertRepeat(economyBackingAlertQueue);
  const economyBackingAlertWorker = createEconomyBackingAlertWorker(logger);

  return [
    holdReleaseWorker,
    ipAllowlistRefreshWorker,
    postbackFraudHookWorker,
    referralCreditWorker,
    novelImportWorker,
    novelCoverWorker,
    catalogCrawlerWorker,
    economyBackingAlertWorker,
  ];
}
