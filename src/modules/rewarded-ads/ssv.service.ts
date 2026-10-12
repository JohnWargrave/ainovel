import { uuidv7 } from 'uuidv7';
import type { Queue } from 'bullmq';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { COIN_PER_USD } from '../../lib/economy.js';
import { creditInTransaction } from '../wallet-ledger/ledger.service.js';
import { recordMint, recordRevenue } from '../wallet-ledger/economy-counters.js';
import { logRawRequest, setVerdict } from '../postback/postback-log.js';
import { enqueueFraudHookJob } from '../../jobs/postback-fraud-hook.js';
import { enqueueReferralCreditJob } from '../../jobs/referral-credit.js';
import {
  getPlacementFeature,
  getRewardedAdsFeature,
  REWARDED_AD_PLACEMENTS,
  type RewardedAdPlacement,
} from './region-feature.js';
import type { VerifierKeyStore } from './admob-verify.js';
import type { SsvQuery } from './schemas.js';

const NETWORK = 'admob_ssv';
const REWARDED_AD_SHARE = 0.2; // 01-COIN-ECONOMY.md §2.2: 20% of estimated eCPM

export interface SsvDeps {
  verifierKeyStore: VerifierKeyStore;
  fraudHookQueue: Pick<Queue, 'add'>;
  referralCreditQueue: Pick<Queue, 'add'>;
}

export interface SsvInput {
  rawUrl: string;
  query: SsvQuery;
  ip: string;
}

// Content to verify is the raw query string up to (not including) "&signature=" — Fastify's parsed
// request.query is decoded/reordered and can't be used to reconstruct the exact bytes Google signed
// ("Content from the SSV callback should not be modified in any way (including keeping the order of
// query parameters)"). Google's reference verifier cuts at the same point — indexOf("signature=")
// then substring(0, i - 1) to drop the preceding "&". `signature` and `key_id` are always the last
// two params, in that order, so everything before the cut is the signed payload.
function extractSignedContent(rawUrl: string): string {
  const queryStart = rawUrl.indexOf('?');
  const rawQueryString = queryStart >= 0 ? rawUrl.slice(queryStart + 1) : '';
  const sigIndex = rawQueryString.indexOf('&signature=');
  if (sigIndex < 0) {
    throw new AppError('BAD_SIGNATURE', 'Missing signature param in AdMob SSV callback', 403);
  }
  return rawQueryString.slice(0, sigIndex);
}

// A multiplier of exactly 0 means "this placement's reward is not coin" — a lucky-spin ad buys a
// spin, and paying coin on top would reward the ad twice. It has to short-circuit before the
// Math.max(raw, 5) floor, which otherwise turns the intended zero into 5.
function computeCoin(estEcpmUsd: number, coinCap: number, coinMultiplier: number): number {
  if (coinMultiplier === 0) return 0;
  const raw = Math.floor((estEcpmUsd / 1000) * COIN_PER_USD * REWARDED_AD_SHARE * coinMultiplier);
  return Math.min(Math.max(raw, 5), coinCap);
}

function asPlacement(value: string | null): RewardedAdPlacement | null {
  return REWARDED_AD_PLACEMENTS.includes(value as RewardedAdPlacement)
    ? (value as RewardedAdPlacement)
    : null;
}

export async function processAdmobSsv(input: SsvInput, deps: SsvDeps): Promise<void> {
  const logId = await logRawRequest(NETWORK, input.ip, input.query);

  try {
    // Only `signature` and `key_id` authenticate the request, so only their absence is a 403. The
    // rest is payload: rejecting a *validly signed* Google request for a missing payload field
    // conflates "this isn't Google" with "Google sent nothing to credit", and the two need opposite
    // responses — see the 200 below.
    const keyId = Number(input.query['key_id']);
    const signature = input.query['signature'];
    if (!signature || !Number.isFinite(keyId)) {
      throw new AppError('BAD_SIGNATURE', 'Missing signature or key_id in AdMob SSV callback', 403);
    }

    const content = extractSignedContent(input.rawUrl);
    const isValid = await deps.verifierKeyStore.verify(content, signature, keyId);
    if (!isValid) {
      throw new AppError('BAD_SIGNATURE', 'AdMob SSV signature verification failed', 403);
    }

    // Signed by Google, but carrying nothing to credit. Two ways to get here, both needing a 200:
    // the AdMob console's "Verify URL" check, where custom_data and user_id are optional fields and
    // are normally left blank; and a real impression served before the app attached custom data.
    // A 403 fails the console check outright, and on a live callback would burn Google's 5 retries
    // and drop the reward permanently — same reasoning as the unknown-intent branch just below.
    const customData = input.query['custom_data'];
    const transactionId = input.query['transaction_id'];
    if (!customData || !transactionId) {
      await setVerdict(logId, 'error');
      return;
    }

    const intentSnapshot = await db
      .selectFrom('rewarded_ad_intents')
      .selectAll()
      .where('id', '=', customData)
      .executeTakeFirst();
    if (!intentSnapshot) {
      // Not something we can act on — still 200 so Google doesn't retry-storm us over it.
      await setVerdict(logId, 'error');
      return;
    }

    const feature = await getRewardedAdsFeature(intentSnapshot.region_id);
    const placement = asPlacement(intentSnapshot.placement);
    const limits = getPlacementFeature(feature, placement);
    const coin = computeCoin(feature.est_ecpm_usd, feature.coin_cap, limits.coin_multiplier);
    const payoutUsdEstimate = feature.est_ecpm_usd / 1000;

    const outcome = await db.transaction().execute(async (trx) => {
      // Lock and re-check inside the credit transaction so concurrent callbacks for one intent
      // cannot both observe `pending` and mint twice.
      const intent = await trx
        .selectFrom('rewarded_ad_intents')
        .selectAll()
        .where('id', '=', customData)
        .forUpdate()
        .executeTakeFirst();
      if (!intent) return { kind: 'error' as const };
      // AdMob echoes back whatever the app passed to setUserId. It is not authenticated on its own —
      // the signature is — but when present it must agree with the intent's owner, so a callback
      // cannot be steered at a different account than the one that minted the nonce.
      const claimedUserId = input.query['user_id'];
      if (claimedUserId && claimedUserId !== intent.user_id) {
        return { kind: 'user_mismatch' as const };
      }
      if (intent.status === 'consumed') {
        return {
          kind: 'duplicate' as const,
          earningEventId: intent.earning_event_id ?? undefined,
        };
      }
      if (intent.status !== 'pending' || new Date() > new Date(intent.expires_at)) {
        await trx
          .updateTable('rewarded_ad_intents')
          .set({ status: 'expired' })
          .where('id', '=', intent.id)
          .where('status', '=', 'pending')
          .execute();
        return { kind: 'error' as const };
      }

      const newEarningEventId = uuidv7();

      await trx
        .insertInto('earning_events')
        .values({
          id: newEarningEventId,
          user_id: intent.user_id,
          device_id: null,
          source: NETWORK,
          network_tx_id: transactionId,
          payout_usd: payoutUsdEstimate.toString(),
          coin_awarded: coin,
          share_applied: null,
          // Captured from the app's own intent request — see 1700000000059. Deliberately NOT
          // input.ip: this is a server-to-server callback, so that address is Google's.
          geo_at_event: intent.geo_at_intent,
          ip_at_event: intent.ip_at_intent,
          placement: intent.placement,
          status: 'credited',
          raw_payload: JSON.stringify(input.query),
        })
        .execute();

      // A zero-coin placement still records the earning_event (the impression happened, and it is
      // what the quota and the revenue report count) but mints nothing. creditInTransaction rejects
      // a zero amount, and calling it would be wrong anyway — there is no ledger entry to make.
      const economy =
        coin > 0
          ? await creditInTransaction(trx, {
              userId: intent.user_id,
              entryType: 'REWARDED_AD_CREDIT',
              amount: coin,
              refType: 'earning_event',
              refId: newEarningEventId,
              idempotencyKey: `${NETWORK}:${transactionId}`,
              revenueUsd: payoutUsdEstimate,
            })
          : { regionId: intent.region_id, mintedAmount: 0, revenueUsd: payoutUsdEstimate };

      await trx
        .updateTable('rewarded_ad_intents')
        .set({
          status: 'consumed',
          coin_awarded: coin,
          earning_event_id: newEarningEventId,
          consumed_at: new Date(),
        })
        .where('id', '=', intent.id)
        .where('status', '=', 'pending')
        .execute();

      return {
        kind: 'accepted' as const,
        economy,
        earningEventId: newEarningEventId,
        userId: intent.user_id,
      };
    });

    if (outcome.kind === 'duplicate') {
      await setVerdict(logId, 'duplicate', outcome.earningEventId);
      return;
    }
    if (outcome.kind === 'user_mismatch') {
      await setVerdict(logId, 'user_not_found');
      return;
    }
    if (outcome.kind === 'error') {
      await setVerdict(logId, 'error');
      return;
    }

    await setVerdict(logId, 'accepted', outcome.earningEventId);
    enqueueFraudHookJob(deps.fraudHookQueue, {
      earningEventId: outcome.earningEventId,
      userId: outcome.userId,
      network: NETWORK,
    });
    enqueueReferralCreditJob(deps.referralCreditQueue, {
      earningEventId: outcome.earningEventId,
      refereeId: outcome.userId,
      entryType: 'REWARDED_AD_CREDIT',
    });

    if (outcome.economy.regionId) {
      void recordMint(outcome.economy.regionId, outcome.economy.mintedAmount).catch(
        () => undefined,
      );
      void recordRevenue(outcome.economy.regionId, outcome.economy.revenueUsd).catch(
        () => undefined,
      );
    }
  } catch (err) {
    if (err instanceof AppError) {
      const verdict = err.code === 'BAD_SIGNATURE' ? 'bad_signature' : 'error';
      await setVerdict(logId, verdict).catch(() => undefined);
    }
    throw err;
  }
}
