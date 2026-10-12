import { createHash, createHmac } from 'node:crypto';
import { AppError } from '../../../lib/errors.js';
import { constantTimeEqual } from './timing-safe-equal.js';
import type { NormalizedPostback, PostbackQuery, SignedNetworkVerifyConfig } from './types.js';

// adjoe and AppsPrize publish account-specific callback templates. Keeping the signed field list
// in network_config lets deployment configure the exact template from the provider dashboard,
// while this adapter still rejects unsigned or ambiguous callbacks by default.
export function verifySignedNetwork(
  query: PostbackQuery,
  config: SignedNetworkVerifyConfig,
): NormalizedPostback {
  const txId = query['transaction_id'] ?? query['tx_id'] ?? query['transaction'] ?? query['id'];
  const userId = query['user_id'] ?? query['uid'] ?? query['sub_id'] ?? query['snuid'];
  const payoutRaw = query['payout_usd'] ?? query['payout'] ?? query['reward'] ?? query['value'];
  const signature = query[config.signatureParam ?? 'signature'] ?? query['hash'];
  if (!txId || !userId || !payoutRaw || !signature) {
    throw new AppError('BAD_SIGNATURE', 'Missing required signed network params', 403);
  }

  const fields = config.signatureFields ?? ['transaction_id', 'user_id', 'payout_usd'];
  const payload = fields.map((field) => query[field] ?? '').join(':');
  const expected =
    config.signatureFormat === 'md5'
      ? createHash('md5').update(`${config.secretKey}${payload}`).digest('hex')
      : createHmac('sha256', config.secretKey).update(payload).digest('hex');
  if (!constantTimeEqual(expected, signature)) {
    throw new AppError('BAD_SIGNATURE', 'Network signature mismatch', 403);
  }

  const payoutUsd = Number(payoutRaw);
  if (!Number.isFinite(payoutUsd) || payoutUsd === 0) {
    throw new AppError('BAD_SIGNATURE', 'Network payout is not numeric', 403);
  }
  const currencyPerUsd = config.currencyPerUsd ? Number(config.currencyPerUsd) : 1;
  const amountUsd = Math.abs(payoutUsd) / currencyPerUsd;
  const status = query['status'] ?? query['event'] ?? '';
  return {
    networkTxId: txId,
    userId,
    payoutUsd: amountUsd,
    isReversal: payoutUsd < 0 || (config.reversalValues ?? []).includes(status),
    raw: query,
  };
}
