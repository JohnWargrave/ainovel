import { uuidv7 } from 'uuidv7';
import type { Queue } from 'bullmq';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { COIN_PER_USD } from '../../lib/economy.js';
import { creditInTransaction, debitInTransaction } from '../wallet-ledger/ledger.service.js';
import { recordMint, recordRevenue } from '../wallet-ledger/economy-counters.js';
import { getNetworkConfig, type NetworkConfig } from './network-config.js';
import { getOfferwallShare } from './offerwall-share.js';
import { isIpAllowed } from './ip-check.js';
import { logRawRequest, setVerdict } from './postback-log.js';
import { enqueueFraudHookJob } from '../../jobs/postback-fraud-hook.js';
import { enqueueReferralCreditJob } from '../../jobs/referral-credit.js';
import {
  propagateReferralClawback,
  evaluateReferralClawbackRate,
} from '../referral/referral-credit.service.js';
import { verifyTapjoy } from './verify/tapjoy.js';
import { verifyAdGate } from './verify/adgate.js';
import { verifyPubScale } from './verify/pubscale.js';
import { verifyAdjoe } from './verify/adjoe.js';
import { verifyAppsPrize } from './verify/apps-prize.js';
import type { NormalizedPostback, PostbackQuery } from './verify/types.js';

export interface PostbackInput {
  ip: string;
  query: PostbackQuery;
}

export interface PostbackDeps {
  fraudHookQueue: Pick<Queue, 'add'>;
  referralCreditQueue: Pick<Queue, 'add'>;
}

function verifyForNetwork(
  network: string,
  query: PostbackQuery,
  config: NetworkConfig,
): NormalizedPostback {
  switch (network) {
    case 'tapjoy':
      return verifyTapjoy(query, {
        secretKey: config.secretKey,
        currencyPerUsd: config.currencyPerUsd,
      });
    case 'adgate':
      return verifyAdGate(query, { secretKey: config.secretKey });
    case 'pubscale':
      return verifyPubScale(query, {
        secretKey: config.secretKey,
        currencyPerUsd: config.currencyPerUsd,
      });
    case 'adjoe':
      return verifyAdjoe(query, config);
    case 'appsprize':
      return verifyAppsPrize(query, config);
    default:
      throw new AppError('NETWORK_NOT_FOUND', `No verifier implemented for ${network}`, 404);
  }
}

async function processCredit(
  network: string,
  normalized: NormalizedPostback,
  user: { id: string; region_id: string; trust_level: number; status: string },
  config: NetworkConfig,
): Promise<string> {
  const share = await getOfferwallShare(user.region_id, user.trust_level);
  const coinAwarded = Math.round(normalized.payoutUsd * COIN_PER_USD * share);
  const holdHours =
    normalized.payoutUsd > config.highValueThresholdUsd
      ? config.highValueHoldHours
      : config.holdHours;
  // The network has paid, so the credit is still recorded — but a suspended/banned account never
  // gets it as spendable coin: it is held, and releaseHold skips it until the account is reinstated.
  const creditImmediately = config.creditImmediately && user.status === 'active';
  const bucket = creditImmediately ? 'available' : 'pending';
  const holdUntil = creditImmediately
    ? undefined
    : new Date(Date.now() + holdHours * 60 * 60 * 1000);
  const earningEventId = uuidv7();

  const result = await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('earning_events')
      .values({
        id: earningEventId,
        user_id: user.id,
        device_id: null,
        source: network,
        network_tx_id: normalized.networkTxId,
        payout_usd: normalized.payoutUsd.toString(),
        coin_awarded: coinAwarded,
        share_applied: share.toString(),
        geo_at_event: null,
        ip_at_event: null,
        status: 'credited',
        raw_payload: JSON.stringify(normalized.raw),
      })
      .execute();

    return creditInTransaction(trx, {
      userId: user.id,
      entryType: 'OFFERWALL_CREDIT',
      amount: coinAwarded,
      bucket,
      ...(holdUntil ? { holdUntil } : {}),
      refType: 'earning_event',
      refId: earningEventId,
      idempotencyKey: `${network}:${normalized.networkTxId}`,
      revenueUsd: normalized.payoutUsd,
    });
  });

  if (result.regionId) {
    void recordMint(result.regionId, result.mintedAmount).catch(() => undefined);
    void recordRevenue(result.regionId, result.revenueUsd).catch(() => undefined);
  }

  return earningEventId;
}

interface OriginalEarningEvent {
  id: string;
  user_id: string;
  coin_awarded: number | string;
  status: string;
}

async function processReversal(
  network: string,
  normalized: NormalizedPostback,
  original: OriginalEarningEvent,
): Promise<{ referrerId: string | null }> {
  const referral = await db.transaction().execute(async (trx) => {
    // Read and lock the original credit inside the clawback transaction: a hold-release committing
    // between a bare read and the debit would otherwise make us debit the wrong bucket.
    const originalLedgerEntry = await trx
      .selectFrom('coin_ledger')
      .select(['id', 'hold_until'])
      .where('ref_type', '=', 'earning_event')
      .where('ref_id', '=', original.id)
      .where('entry_type', '=', 'OFFERWALL_CREDIT')
      .forUpdate()
      .executeTakeFirst();
    // Still-held coin lives in pending_coin (CHECK(pending_coin >= 0) — a legitimate reversal never
    // exceeds what's still held there); once released to available_coin, clawbacks are allowed to push
    // it negative (see wallets migration comment).
    const stillHeld = originalLedgerEntry?.hold_until != null;

    await debitInTransaction(trx, {
      userId: original.user_id,
      entryType: 'OFFERWALL_CLAWBACK',
      amount: Number(original.coin_awarded),
      bucket: stillHeld ? 'pending' : 'available',
      allowNegative: !stillHeld,
      refType: 'earning_event',
      refId: original.id,
      idempotencyKey: `${network}:${normalized.networkTxId}:clawback`,
    });
    if (originalLedgerEntry && stillHeld) {
      // The held coin is gone — clear the hold so the release sweep never moves it to available.
      await trx
        .updateTable('coin_ledger')
        .set({ hold_until: null })
        .where('id', '=', originalLedgerEntry.id)
        .execute();
    }
    await trx
      .updateTable('earning_events')
      .set({ status: 'clawed_back' })
      .where('id', '=', original.id)
      .execute();
    return propagateReferralClawback(trx, original.id);
  });

  return { referrerId: referral?.referrerId ?? null };
}

export async function processPostback(
  network: string,
  input: PostbackInput,
  deps: PostbackDeps,
): Promise<void> {
  const logId = await logRawRequest(network, input.ip, input.query);

  try {
    const config = await getNetworkConfig(network);
    const normalized = verifyForNetwork(network, input.query, config);

    if (!isIpAllowed(input.ip, config.allowedIps)) {
      // 15§7 quarantine: signature already proved this is genuinely the network (not a random
      // prober), so a stale/unlisted IP is held for review instead of hard-rejected — avoids losing
      // legitimate revenue to IP-rotation lag on the network's side.
      await setVerdict(logId, 'quarantined');
      return;
    }

    if (normalized.isReversal) {
      // A reversal notification reuses the *original credit's* network_tx_id (it's reporting on the
      // same offer, not a new one) — so an existing earning_events row here is the expected case, not
      // a duplicate. Duplicate protection for reversals is instead "already clawed_back".
      const original = await db
        .selectFrom('earning_events')
        .select(['id', 'user_id', 'coin_awarded', 'status'])
        .where('source', '=', network)
        .where('network_tx_id', '=', normalized.networkTxId)
        .executeTakeFirst();
      if (!original) {
        // A clawback for something never credited is a network-side inconsistency, not something we
        // can act on — still replies 200 so the network doesn't retry-storm us over it.
        await setVerdict(logId, 'error');
        return;
      }
      if (original.status === 'clawed_back') {
        await setVerdict(logId, 'duplicate', original.id);
        return;
      }
      const { referrerId } = await processReversal(network, normalized, original);
      await setVerdict(logId, 'accepted', original.id);
      enqueueFraudHookJob(deps.fraudHookQueue, {
        earningEventId: original.id,
        userId: original.user_id,
        network,
      });
      if (referrerId) {
        void evaluateReferralClawbackRate(referrerId).catch(() => undefined);
      }
      return;
    }

    const existing = await db
      .selectFrom('earning_events')
      .select('id')
      .where('source', '=', network)
      .where('network_tx_id', '=', normalized.networkTxId)
      .executeTakeFirst();
    if (existing) {
      await setVerdict(logId, 'duplicate', existing.id);
      return;
    }

    const user = await db
      .selectFrom('users')
      .select(['id', 'region_id', 'trust_level', 'status'])
      .where('id', '=', normalized.userId)
      .executeTakeFirst();
    if (!user) {
      // Not 403: an unknown user_id is a permanently-bad reference, not an auth failure — replying
      // 200 stops the network from retrying a postback that will never succeed.
      await setVerdict(logId, 'user_not_found');
      return;
    }

    if (config.shadowMode) {
      // Shadow-mode: verdict recorded as if accepted (for later diffing against what a live rollout
      // would have credited), but no earning_events/ledger write — see 15§7.
      await setVerdict(logId, 'accepted');
      return;
    }

    const earningEventId = await processCredit(network, normalized, user, config);
    await setVerdict(logId, 'accepted', earningEventId);
    enqueueFraudHookJob(deps.fraudHookQueue, {
      earningEventId,
      userId: user.id,
      network,
    });
    enqueueReferralCreditJob(deps.referralCreditQueue, {
      earningEventId,
      refereeId: user.id,
      entryType: 'OFFERWALL_CREDIT',
    });
  } catch (err) {
    if (err instanceof AppError) {
      const verdict = err.code === 'BAD_SIGNATURE' ? 'bad_signature' : 'error';
      await setVerdict(logId, verdict).catch(() => undefined);
    }
    throw err;
  }
}
