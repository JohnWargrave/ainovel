import { createHash } from 'node:crypto';
import { AppError } from '../../../lib/errors.js';
import { constantTimeEqual } from './timing-safe-equal.js';
import type { NormalizedPostback, PostbackQuery } from './types.js';

export interface PubScaleVerifyConfig {
  secretKey: string;
  currencyPerUsd: string | null;
}

// PubScale S2S spec (offerwall-sdk/server-to-server-s2s-callback-configuration):
//   signature = hex(md5(secret_key . user_id . trunc(value) . token))
// Two things differ from Tapjoy and are easy to get backwards: the secret goes *first*, and `value`
// is truncated to an integer before hashing (the docs' own examples turn 100.1234 into 100).
export function verifyPubScale(
  query: PostbackQuery,
  config: PubScaleVerifyConfig,
): NormalizedPostback {
  const userId = query['user_id'];
  const valueRaw = query['value'];
  const token = query['token'];
  const signature = query['signature'];
  if (!userId || !valueRaw || !token || !signature) {
    throw new AppError('BAD_SIGNATURE', 'Missing required PubScale postback params', 403);
  }

  const value = Number(valueRaw);
  if (!Number.isFinite(value)) {
    throw new AppError('BAD_SIGNATURE', 'PubScale value param is not numeric', 403);
  }

  const expected = createHash('md5')
    .update(`${config.secretKey}.${userId}.${String(Math.trunc(value))}.${token}`)
    .digest('hex');
  if (!constantTimeEqual(expected, signature)) {
    throw new AppError('BAD_SIGNATURE', 'PubScale signature mismatch', 403);
  }

  // Deliberately derived from the *signed* `value`, not the optional `payout_usd` param PubScale also
  // sends: the signature only covers user_id/value/token, so payout_usd is unsigned and mutable in
  // transit. It's still captured in raw_payload for later reconciliation against the dashboard.
  //
  // Because the signature hashes only the integer part of `value`, sub-unit tampering stays possible;
  // network_config.currency_per_usd must therefore be large enough that one unit is a negligible
  // amount (at the seeded 1000, one unit is $0.001).
  const currencyPerUsd = config.currencyPerUsd ? Number(config.currencyPerUsd) : 1000;
  const payoutUsd = Math.abs(value) / currencyPerUsd;

  return {
    networkTxId: token,
    userId,
    payoutUsd,
    // PubScale's S2S docs describe no reversal/chargeback callback at all — no negative value, no
    // event type, no clawback param. Hardcoded false rather than guessed at; if a reversal channel
    // turns out to exist, it needs its own verified shape before being wired to a debit.
    isReversal: false,
    raw: query,
  };
}
