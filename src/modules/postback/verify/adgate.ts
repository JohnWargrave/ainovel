import { createHmac } from 'node:crypto';
import { AppError } from '../../../lib/errors.js';
import { constantTimeEqual } from './timing-safe-equal.js';
import type { NormalizedPostback, PostbackQuery } from './types.js';

export interface AdGateVerifyConfig {
  secretKey: string;
}

// TODO(verify): AdGate's primary defense is the IP allowlist (checked by the caller via
// ip-check.ts) — 04-POSTBACK-SPEC.md §4 says only "optional hash param, bật cả hai nếu có" without
// naming it. `hash`/`signature` + this HMAC-SHA256 shape is a placeholder enforced only when the
// param is actually present, until a live AdGate dashboard confirms the real name/algorithm.
export function verifyAdGate(query: PostbackQuery, config: AdGateVerifyConfig): NormalizedPostback {
  const txId = query['tx_id'];
  const userId = query['user_id'];
  const payoutRaw = query['payout'];
  const status = query['status'];
  if (!txId || !userId || !payoutRaw) {
    throw new AppError('BAD_SIGNATURE', 'Missing required AdGate postback params', 403);
  }

  const hash = query['hash'] ?? query['signature'];
  if (hash) {
    const expected = createHmac('sha256', config.secretKey)
      .update(`${txId}:${userId}:${payoutRaw}`)
      .digest('hex');
    if (!constantTimeEqual(expected, hash)) {
      throw new AppError('BAD_SIGNATURE', 'AdGate hash mismatch', 403);
    }
  }

  const payoutUsd = Number(payoutRaw);
  if (!Number.isFinite(payoutUsd)) {
    throw new AppError('BAD_SIGNATURE', 'AdGate payout param is not numeric', 403);
  }

  return {
    networkTxId: txId,
    userId,
    payoutUsd: Math.abs(payoutUsd),
    isReversal: status === '0' || status === '2',
    raw: query,
  };
}
