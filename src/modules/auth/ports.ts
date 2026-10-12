// Seams for dependency injection: real implementations call out to Google/Facebook (network calls
// tests can't make in CI), while integration tests inject fake identity providers.

export interface OAuthIdentity {
  subject: string; // provider-scoped user id
  email: string | null;
  emailVerified?: boolean | undefined;
}

export interface IdentityProvider {
  verify(idToken: string): Promise<OAuthIdentity>;
}

export interface AuthProviders {
  google: IdentityProvider;
  facebook: IdentityProvider;
}
