# Authentication

`users.id` is the stable account identifier. Login methods are attached through
`user_identities` (guest/Google/Facebook) and `password_credentials`; matching email addresses never
merge accounts automatically.

## Android installation identity

- `POST /auth/guest`, `/auth/google`, `/auth/facebook`, and `/auth/password/register` require
  `X-Device-Id` to be a non-zero UUID generated once per app installation and persisted by the app.
- Guest identity is `SHA-256("installation:" + X-Device-Id)`. Reusing that installation ID recovers
  the same guest account even when the model, OS, or GAID changes.
- `device.gaid` is optional metadata for fraud/attribution. Missing, empty, malformed, and zero GAIDs
  are stored as `NULL`; GAID is not the guest user ID.
- Existing GAID-based guest accounts migrate to installation identity on their next matching login,
  preserving the user ID, wallet, and history.
- Play Integrity is retired. Auth does not accept or require an integrity key/token.

## Player security

- Passwords use Argon2id (64 MiB, 3 iterations, parallelism 1).
- Usernames and password-account emails are unique case-insensitively.
- Access tokens last 1 hour. Refresh tokens last 30 days, rotate once, and are stored only as
  SHA-256 hashes.
- Every token pair belongs to a server-revocable session. Logout, password changes/resets, account
  suspension, and CMS actions invalidate access immediately.
- Verification/reset tokens are random, stored only as SHA-256 hashes, expire, and are single-use.
- Forgot-password responses never disclose whether an email exists.
- Each stable account can receive exactly one `WELCOME_CREDIT`; its CMS-configurable default is
  10,000 coin. The service check, idempotency key, wallet lock, and partial unique database index
  enforce this together.
- Google authentication can grant one `LOGIN_BIND_CREDIT` per stable account; its CMS-configurable
  default is 2,000 coin. Facebook and password linking do not grant this reward.
- `GET /auth/login-offers` lists the effective first-account rewards shown before sign-in. Password
  receives the welcome amount; Google receives welcome plus the Google first-login bonus.

## Recovery email

The Node backend uses Cloudflare Email Service's REST API. Configure
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN`, `AUTH_EMAIL_FROM`,
`AUTH_EMAIL_VERIFY_URL`, and `AUTH_PASSWORD_RESET_URL`. The sender domain must be onboarded for
Email Sending with valid SPF/DKIM; DMARC is recommended.

## CMS login

CMS browser login uses individual admin email/password credentials and opaque, server-side,
revocable sessions. Provision an admin after building/migrating:

```bash
ADMIN_NEW_PASSWORD='use-a-long-unique-password' pnpm admin:set-password -- admin@example.com superadmin
```

The legacy `x-admin-api-key` integration is disabled by default. Enable
`ENABLE_LEGACY_ADMIN_API_KEY=true` only during a controlled integration migration.
