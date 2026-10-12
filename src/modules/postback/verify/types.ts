export type PostbackQuery = Record<string, string | undefined>;

export interface NormalizedPostback {
  networkTxId: string;
  userId: string;
  payoutUsd: number;
  isReversal: boolean;
  raw: PostbackQuery;
}

export interface SignedNetworkVerifyConfig {
  secretKey: string;
  currencyPerUsd: string | null;
  signatureParam?: string;
  signatureFormat?: 'hmac-sha256' | 'md5';
  signatureFields?: string[];
  reversalValues?: string[];
}
