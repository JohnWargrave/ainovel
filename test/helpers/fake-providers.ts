import type { IdentityProvider, OAuthIdentity } from '../../src/modules/auth/ports.js';

// idToken encodes `${subject}[:${email}]` so each test call can control which identity it
// represents without a shared fixture — mirrors real providers just enough for auth.service.ts's
// orchestration logic to be exercised end-to-end without a network call.
export function fakeIdentityProvider(): IdentityProvider {
  return {
    verify(idToken: string): Promise<OAuthIdentity> {
      const [subject, email] = idToken.split(':');
      if (!subject) {
        throw new Error('fake identity provider: empty subject');
      }
      return Promise.resolve({ subject, email: email ?? null, emailVerified: email !== undefined });
    },
  };
}
