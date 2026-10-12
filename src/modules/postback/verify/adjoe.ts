import { verifySignedNetwork } from './signed-network.js';
import type { NormalizedPostback, PostbackQuery, SignedNetworkVerifyConfig } from './types.js';

export function verifyAdjoe(
  query: PostbackQuery,
  config: SignedNetworkVerifyConfig,
): NormalizedPostback {
  return verifySignedNetwork(query, {
    ...config,
    signatureParam: config.signatureParam ?? 'signature',
    signatureFields: config.signatureFields ?? ['transaction_id', 'user_id', 'payout_usd'],
  });
}
