import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import { db } from '../../db/index.js';
import type { DB, LedgerEntryType } from '../../db/types.js';
import { COIN_PER_USD, MAX_TOTAL_SHARE } from '../../lib/economy.js';
import {
  creditInTransaction,
  debitInTransaction,
  credit,
} from '../wallet-ledger/ledger.service.js';
import { recordMint } from '../wallet-ledger/economy-counters.js';
import { ensureOpenFraudFlag } from '../fraud/ensure-open-flag.js';
import { hasOpenFraudFlag } from '../fraud/has-open-flag.js';
import { recomputeScoreInTx } from '../fraud/score.service.js';
import { getReferralFeature } from './region-feature.js';

// RF02/RF03 freeze (11-REFERRAL.md §3): coin still accrues into `pending` but is never released
// until a human reviews the flag. creditInTransaction requires a holdUntil for the pending bucket
// (so "no hold" isn't an option), and hold-release.ts's sweep (`hold_until <= now()`) structurally
// never matches a date this far out — the reset action (a plain UPDATE) is trivially available to a
// future admin review flow without touching the generic hold-release primitive.
export const FROZEN_HOLD_UNTIL = new Date('2099-01-01T00:00:00Z');

const MIN_REFEREES_FOR_CLAWBACK_RATE = 5; // mirrors E01's MIN_EVENTS
const CLAWBACK_RATE_THRESHOLD = 0.3; // 11-REFERRAL.md §3 RF04

export interface ReferralCreditPayload {
  earningEventId: string;
  refereeId: string;
  entryType: 'OFFERWALL_CREDIT' | 'REWARDED_AD_CREDIT';
}

// 11-REFERRAL.md §2-3: single-level 10% revenue-share on the referee's *backed* earning events only,
// starting the event *after* the referee qualifies (welcome credit + first backed offer >= $0.10) —
// the qualifying event itself never spawns a REFERRAL_CREDIT. Reads happen against plain
// `db` up front (cheap, mostly-no-op path for the common "not referred" case, same risk profile as
// evaluateClawbackRate); the actual credit happens in its own transaction at the end.
export async function processReferralCredit(payload: ReferralCreditPayload): Promise<void> {
  const referee = await db
    .selectFrom('users')
    .select(['referred_by', 'referred_by_set_at', 'referral_qualified_at'])
    .where('id', '=', payload.refereeId)
    .executeTakeFirst();
  if (!referee?.referred_by) return;
  const referrerId = referee.referred_by;

  const event = await db
    .selectFrom('earning_events')
    .select(['status', 'payout_usd', 'coin_awarded'])
    .where('id', '=', payload.earningEventId)
    .executeTakeFirst();
  if (event?.status !== 'credited') return;

  const referrer = await db
    .selectFrom('users')
    .select(['region_id'])
    .where('id', '=', referrerId)
    .executeTakeFirst();
  if (!referrer) return;

  const feature = await getReferralFeature(referrer.region_id);
  if (!feature.enabled) return;

  if (feature.duration_months !== null && referee.referred_by_set_at) {
    const expiresAt = new Date(referee.referred_by_set_at);
    expiresAt.setMonth(expiresAt.getMonth() + feature.duration_months);
    if (Date.now() > expiresAt.getTime()) return;
  }

  // RF04: referral fully disabled for this referrer — no credit, no milestone bonus.
  if (await hasOpenFraudFlag(referrerId, ['RF04'])) return;

  if (!referee.referral_qualified_at) {
    const hasWelcome = await db
      .selectFrom('coin_ledger')
      .select('id')
      .where('user_id', '=', payload.refereeId)
      .where('entry_type', '=', 'WELCOME_CREDIT')
      .executeTakeFirst();
    const qualifies = hasWelcome !== undefined && Number(event.payout_usd) >= 0.1;
    if (qualifies) {
      await db
        .updateTable('users')
        .set({ referral_qualified_at: new Date() })
        .where('id', '=', payload.refereeId)
        .where('referral_qualified_at', 'is', null)
        .execute();
    }
    // Whether or not this event was the qualifying one, it never itself spawns a REFERRAL_CREDIT.
    return;
  }

  const refereeCoin = Number(event.coin_awarded);
  const payoutUsd = Number(event.payout_usd);
  const raw = Math.floor(refereeCoin * feature.pct);
  const maxTotal = Math.floor(payoutUsd * COIN_PER_USD * MAX_TOTAL_SHARE);
  const referrerCoin = Math.max(0, Math.min(raw, maxTotal - refereeCoin));
  if (referrerCoin <= 0) return;

  const frozen = await hasOpenFraudFlag(referrerId, ['RF02', 'RF03']);

  const originalLedger = await db
    .selectFrom('coin_ledger')
    .select(['bucket', 'hold_until'])
    .where('ref_type', '=', 'earning_event')
    .where('ref_id', '=', payload.earningEventId)
    .where('entry_type', '=', payload.entryType)
    .executeTakeFirst();

  const configuredHoldUntil =
    feature.hold_hours > 0 ? new Date(Date.now() + feature.hold_hours * 60 * 60 * 1000) : null;
  const originalHoldUntil = originalLedger?.hold_until ?? null;
  const normalHoldUntil = feature.credit_immediately
    ? null
    : configuredHoldUntil && originalHoldUntil
      ? configuredHoldUntil > originalHoldUntil
        ? configuredHoldUntil
        : originalHoldUntil
      : (configuredHoldUntil ?? originalHoldUntil);
  const holdUntil = frozen ? FROZEN_HOLD_UNTIL : normalHoldUntil;
  const bucket: 'available' | 'pending' = holdUntil ? 'pending' : 'available';

  const result = await db.transaction().execute((trx) =>
    creditInTransaction(trx, {
      userId: referrerId,
      entryType: 'REFERRAL_CREDIT',
      amount: referrerCoin,
      bucket,
      ...(holdUntil ? { holdUntil } : {}),
      refType: 'earning_event',
      refId: payload.earningEventId,
      idempotencyKey: `referral:${payload.earningEventId}`,
      note: 'referral revenue-share',
    }),
  );
  // Redistribution of already-recorded revenue, not new revenue — recordRevenue is deliberately not
  // called here (that counter is already correct from the referee's own original credit).
  if (result.regionId) {
    void recordMint(result.regionId, result.mintedAmount).catch(() => undefined);
  }

  if (feature.milestone_bonus_coin > 0) {
    const lifetime = await db
      .selectFrom('earning_events')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('coin_awarded'), eb.lit(0)).as('total'))
      .where('user_id', '=', payload.refereeId)
      .where('status', '=', 'credited')
      .executeTakeFirstOrThrow();
    if (Number(lifetime.total) >= feature.milestone_bonus_threshold) {
      await credit({
        userId: referrerId,
        entryType: 'REFERRAL_CREDIT',
        amount: feature.milestone_bonus_coin,
        bucket,
        ...(holdUntil ? { holdUntil } : {}),
        refType: 'referral_milestone',
        refId: payload.refereeId,
        idempotencyKey: `referral-milestone:${payload.refereeId}`,
        note: 'referral milestone bonus',
      });
    }
  }
}

// Mirrors postback.service.ts's processReversal debit logic exactly — a REFERRAL_CREDIT spawned from
// the original earning event must be reversed the same way when that event is clawed back.
export async function propagateReferralClawback(
  trx: Transaction<DB>,
  originalEarningEventId: string,
): Promise<{ referrerId: string } | null> {
  const entry = await trx
    .selectFrom('coin_ledger')
    .select(['id', 'user_id', 'amount', 'bucket', 'hold_until'])
    .where('ref_type', '=', 'earning_event')
    .where('ref_id', '=', originalEarningEventId)
    .where('entry_type', '=', 'REFERRAL_CREDIT' satisfies LedgerEntryType)
    .executeTakeFirst();
  if (!entry) return null;

  const stillHeld = entry.bucket === 'pending' && entry.hold_until != null;
  await debitInTransaction(trx, {
    userId: entry.user_id,
    entryType: 'REFERRAL_CLAWBACK',
    amount: Number(entry.amount),
    bucket: stillHeld ? 'pending' : 'available',
    allowNegative: !stillHeld,
    refType: 'earning_event',
    refId: originalEarningEventId,
    idempotencyKey: `${originalEarningEventId}:referral-clawback`,
  });
  if (stillHeld) {
    // The pending wallet debit cancels this credit before it becomes available. Clearing its hold
    // prevents the periodic release sweep from later moving the canceled amount into available.
    await trx
      .updateTable('coin_ledger')
      .set({ hold_until: null })
      .where('id', '=', entry.id)
      .execute();
  }

  return { referrerId: entry.user_id };
}

// RF04 (11-REFERRAL.md §3): referrer has >30% of their (qualified) referees clawed back at least
// once -> flag + downgrade trust. An open RF04 flag *is* the "referral disabled" state that
// processReferralCredit checks directly, so no separate boolean is needed.
export async function evaluateReferralClawbackRate(referrerId: string): Promise<void> {
  const totalRow = await db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .where('referred_by', '=', referrerId)
    .where('referral_qualified_at', 'is not', null)
    .executeTakeFirstOrThrow();
  const total = Number(totalRow.total);
  if (total < MIN_REFEREES_FOR_CLAWBACK_RATE) return;

  const clawedRow = await db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<string>().as('clawed'))
    .where('referred_by', '=', referrerId)
    .where('referral_qualified_at', 'is not', null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('earning_events')
          .select('id')
          .whereRef('earning_events.user_id', '=', 'users.id')
          .where('earning_events.status', '=', 'clawed_back'),
      ),
    )
    .executeTakeFirstOrThrow();
  const clawed = Number(clawedRow.clawed);
  const rate = clawed / total;
  if (rate <= CLAWBACK_RATE_THRESHOLD) return;

  await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('fraud_flags')
      .select('id')
      .where('user_id', '=', referrerId)
      .where('rule_code', '=', 'RF04')
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (existing) return;

    await ensureOpenFraudFlag(trx, referrerId, 'RF04', 4, { total, clawed, rate });
    await trx
      .updateTable('users')
      .set({ trust_level: sql`GREATEST(trust_level - 1, 0)` })
      .where('id', '=', referrerId)
      .execute();
    await recomputeScoreInTx(trx, referrerId);
  });
}
