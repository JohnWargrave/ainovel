import { AppError } from '../../lib/errors.js';
import type { IdentityProvider, OAuthIdentity } from './ports.js';

interface DebugTokenResponse {
  data?: {
    is_valid?: boolean;
    user_id?: string;
    app_id?: string;
  };
}

// Graph API token introspection via plain fetch (Node 20 built-in) — no SDK dependency needed for
// a single endpoint call.
export class FacebookIdentityProvider implements IdentityProvider {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  async verify(idToken: string): Promise<OAuthIdentity> {
    const debugUrl = new URL('https://graph.facebook.com/debug_token');
    debugUrl.searchParams.set('input_token', idToken);
    debugUrl.searchParams.set('access_token', `${this.appId}|${this.appSecret}`);

    const debugResponse = await fetch(debugUrl).catch(() => null);
    if (!debugResponse?.ok) {
      throw new AppError('INVALID_ID_TOKEN', 'Facebook token verification failed', 401);
    }
    const body = (await debugResponse.json()) as DebugTokenResponse;
    if (!body.data?.is_valid || body.data.app_id !== this.appId || !body.data.user_id) {
      throw new AppError('INVALID_ID_TOKEN', 'Facebook token is invalid', 401);
    }

    const meUrl = new URL(`https://graph.facebook.com/${body.data.user_id}`);
    meUrl.searchParams.set('fields', 'email');
    meUrl.searchParams.set('access_token', idToken);
    const meResponse = await fetch(meUrl).catch(() => null);
    const email = meResponse?.ok
      ? (((await meResponse.json()) as { email?: string }).email ?? null)
      : null;

    return { subject: body.data.user_id, email, emailVerified: email !== null };
  }
}
