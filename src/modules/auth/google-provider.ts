import { OAuth2Client } from 'google-auth-library';
import { AppError } from '../../lib/errors.js';
import type { IdentityProvider, OAuthIdentity } from './ports.js';

// Offline verification via JWKS (google-auth-library), no network call to our own backend needed
// beyond Google's public key fetch/cache — kept out of the ledger/DB transaction boundary entirely.
//
// Multiple audiences because `aud` is platform-specific and there is no single "the" client id:
// an Android sign-in issues a token whose `aud` is the *Web* client id passed as `serverClientId`
// (the Android client id appears as `azp`), while an iOS sign-in issues one whose `aud` is the iOS
// client id. Configuring only one of them rejects every other platform with INVALID_ID_TOKEN.
export class GoogleIdentityProvider implements IdentityProvider {
  private readonly client: OAuth2Client;

  constructor(private readonly clientIds: string[]) {
    if (clientIds.length === 0) {
      throw new Error('GoogleIdentityProvider requires at least one client id');
    }
    this.client = new OAuth2Client(clientIds[0]);
  }

  async verify(idToken: string): Promise<OAuthIdentity> {
    let failure: unknown;
    const ticket = await this.client
      .verifyIdToken({ idToken, audience: this.clientIds })
      .catch((error: unknown) => {
        failure = error;
        return null;
      });
    const payload = ticket?.getPayload();
    if (!payload?.sub) {
      // An audience mismatch is by far the most common cause and is invisible from the 401 alone,
      // so the rejected token's own claims go to the log next to the ids we accept. Unverified
      // claims — safe to log, never to trust.
      throw new AppError('INVALID_ID_TOKEN', 'Google id_token verification failed', 401, {
        reason: failure instanceof Error ? failure.message : 'no payload in verified token',
        token_claims: decodeUnverifiedClaims(idToken),
        accepted_audiences: this.clientIds,
      });
    }
    return {
      subject: payload.sub,
      email: payload.email ?? null,
      emailVerified: payload.email_verified === true,
    };
  }
}

// Signature-less peek at the claims that explain a rejection. Returns null for anything that is not
// a well-formed JWT — the caller is already on the failure path, so a malformed token is an answer.
function decodeUnverifiedClaims(idToken: string): Record<string, unknown> | null {
  const segment = idToken.split('.')[1];
  if (!segment) return null;
  try {
    const claims = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return {
      aud: claims['aud'],
      azp: claims['azp'],
      iss: claims['iss'],
      exp: claims['exp'],
    };
  } catch {
    return null;
  }
}
