import { createHash } from 'node:crypto';
import { AppError } from '../../../lib/errors.js';
import { constantTimeEqual } from './timing-safe-equal.js';
import type { NormalizedPostback, PostbackQuery } from './types.js';

export interface TapjoyVerifyConfig {
  secretKey: string;
  currencyPerUsd: string | null;
}

// Verified 2026-08-10 against the official self-managed currency docs
// (docs.unity.com/en-us/grow/offerwall/monetization/virtual-currency/self-managed-currency). The page
// gives the formula verbatim as Ruby:
//
//   Digest::MD5.hexdigest("#{id}:#{snuid}:#{currency}:#{secret_key}")
//
// which is exactly what this implements. `id` and `verifier` are only sent once a virtual-currency
// secret key is configured on the dashboard; without one Tapjoy sends snuid/currency/mac_address
// unsigned, and the missing-param check below rejects those outright rather than crediting unsigned
// traffic. `mac_address` is deliberately ignored — it isn't covered by the hash.
//
// The docs describe no chargeback/reversal channel for this callback at all: `currency` is defined
// only as "the amount of currency to add", there is no event-type or refund parameter, and the JSON
// payload of the newer callback has no debit field either. Negative `currency` is kept as the
// reversal trigger anyway — not because it's documented, but because the alternative is treating a
// negative amount as a credit, which would mint coin from a debit.
export function verifyTapjoy(query: PostbackQuery, config: TapjoyVerifyConfig): NormalizedPostback {
  const id = query['id'];
  const snuid = query['snuid'];
  const currencyRaw = query['currency'];
  const verifier = query['verifier'];
  if (!id || !snuid || !currencyRaw || !verifier) {
    throw new AppError('BAD_SIGNATURE', 'Missing required Tapjoy postback params', 403);
  }

  const expected = createHash('md5')
    .update(`${id}:${snuid}:${currencyRaw}:${config.secretKey}`)
    .digest('hex');
  if (!constantTimeEqual(expected, verifier)) {
    throw new AppError('BAD_SIGNATURE', 'Tapjoy verifier mismatch', 403);
  }

  const currency = Number(currencyRaw);
  if (!Number.isFinite(currency)) {
    throw new AppError('BAD_SIGNATURE', 'Tapjoy currency param is not numeric', 403);
  }

  const currencyPerUsd = config.currencyPerUsd ? Number(config.currencyPerUsd) : 1000;
  const payoutUsd = Math.abs(currency) / currencyPerUsd;

  return {
    networkTxId: id,
    userId: snuid,
    payoutUsd,
    isReversal: currency < 0,
    raw: query,
  };
}
