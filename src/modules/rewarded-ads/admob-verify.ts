import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

export interface VerifierKey {
  keyId: number;
  pem: string;
}

// Small local port, same pattern as ip-allowlist-refresh.ts's IpRangeSource in 1.3 — not worth its
// own ports.ts for a single interface.
export interface VerifierKeyFetcher {
  fetch(): Promise<VerifierKey[]>;
}

const VERIFIER_KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_BACKOFF_MS = 60 * 1000;

interface GstaticKeysResponse {
  keys?: { keyId: number; pem: string; base64: string }[];
}

export class GstaticVerifierKeyFetcher implements VerifierKeyFetcher {
  async fetch(): Promise<VerifierKey[]> {
    const response = await fetch(VERIFIER_KEYS_URL).catch(() => null);
    if (!response?.ok) return [];
    const body = (await response.json()) as GstaticKeysResponse;
    return (body.keys ?? []).map((k) => ({ keyId: k.keyId, pem: k.pem }));
  }
}

export interface VerifierKeyStore {
  verify(content: string, signatureBase64Url: string, keyId: number): Promise<boolean>;
}

// In-memory cache, TTL 24h (04-POSTBACK-SPEC.md §7: "cache theo key_id, refresh daily") + lazy
// refetch whenever an unknown key_id shows up, so a mid-day key rotation doesn't have to wait for the
// TTL to expire. No BullMQ job like ip-allowlist-refresh.ts — that job exists to surface drift for
// admin review; these keys are public data with no admin action needed, so self-healing is enough.
export function createVerifierKeyStore(
  fetcher: VerifierKeyFetcher = new GstaticVerifierKeyFetcher(),
): VerifierKeyStore {
  let cache = new Map<number, string>();
  let fetchedAt = 0;
  let attemptedAt = 0;

  async function refresh(): Promise<void> {
    // Track the attempt separately from the success, so a gstatic outage (or an unknown key_id that
    // simply is not published) can't make every single callback issue its own outbound request.
    attemptedAt = Date.now();
    const keys = await fetcher.fetch();
    if (keys.length === 0) return;
    cache = new Map(keys.map((k) => [k.keyId, k.pem]));
    fetchedAt = Date.now();
  }

  async function getPem(keyId: number): Promise<string | undefined> {
    const isStale = Date.now() - fetchedAt > CACHE_TTL_MS;
    if (isStale || !cache.has(keyId)) {
      const backoffElapsed = Date.now() - attemptedAt > REFRESH_BACKOFF_MS;
      // A warm-but-stale cache still verifies: keys rotate, they aren't revoked. Better to try an
      // old key than to reject a legitimate callback Google will only retry 5 times.
      if (backoffElapsed || cache.size === 0) {
        await refresh();
      }
    }
    return cache.get(keyId);
  }

  return {
    async verify(content: string, signatureBase64Url: string, keyId: number): Promise<boolean> {
      const pem = await getPem(keyId);
      if (!pem) return false;
      try {
        const publicKey = createPublicKey(pem);
        const signature = Buffer.from(signatureBase64Url, 'base64url');
        // ECDSA P-256 / SHA-256 with a DER-encoded (r,s) signature, per Google's reference verifier
        // (developers.google.com/admob/android/ssv uses `EcdsaEncoding.DER`). Real signature values
        // start "MEUCIQ..." — base64url for 30 45 02 21, an ASN.1 DER SEQUENCE header. Deliberately
        // DER-only: also accepting raw ieee-p1363 would widen the forgery surface for no benefit.
        return cryptoVerify(
          'sha256',
          Buffer.from(content),
          { key: publicKey, dsaEncoding: 'der' },
          signature,
        );
      } catch {
        return false;
      }
    },
  };
}
