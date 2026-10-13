import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const EnvSchema = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
    { default: 'development' },
  ),
  PORT: Type.Integer({ default: 3000, minimum: 1, maximum: 65535 }),
  LOG_LEVEL: Type.String({ default: 'info' }),
  DATABASE_URL: Type.String({ minLength: 1 }),
  REDIS_URL: Type.String({ minLength: 1 }),
  JWT_ACCESS_SECRET: Type.String({ minLength: 1 }),
  JWT_REFRESH_SECRET: Type.String({ minLength: 1 }),
  DELIVERY_CODE_ENC_KEY: Type.String({ minLength: 1 }),
  ADMIN_API_KEY: Type.String({ minLength: 1 }),
  ADMIN_CSRF_TOKEN: Type.String({ minLength: 1 }),
  ENABLE_LEGACY_ADMIN_API_KEY: Type.Boolean({ default: false }),
  CMS_SESSION_SECRET: Type.Optional(Type.String({ minLength: 32 })),
  ENABLE_TEST_COIN_API: Type.Boolean({ default: false }),
  TRUST_PROXY: Type.Optional(Type.String()),
  TAPJOY_POSTBACK_SECRET: Type.Optional(Type.String()),
  PUBSCALE_POSTBACK_SECRET: Type.Optional(Type.String()),
  TAPJOY_PLACEMENT: Type.Optional(Type.String()),
  PUBSCALE_PLACEMENT: Type.Optional(Type.String()),
  MIN_SUPPORTED_APP_VERSION: Type.String({ default: '1.0.0', minLength: 1 }),
  // Optional: no real Google Cloud/Facebook app exists yet (D0 kickoff checklist item, still pending on the
  // user's side). Real auth-provider implementations read these at wire-up time in app.ts, not here, so an
  // empty dev/test environment can still boot and run tests against injected fake providers.
  //
  // GOOGLE_CLIENT_ID accepts a comma-separated list: `aud` differs per platform (Android tokens carry
  // the *Web* client id, iOS tokens carry the iOS one), and all accepted audiences must be listed.
  // Read through `googleClientIds()` rather than splitting at each call site.
  GOOGLE_CLIENT_ID: Type.Optional(Type.String()),
  FACEBOOK_APP_ID: Type.Optional(Type.String()),
  FACEBOOK_APP_SECRET: Type.Optional(Type.String()),
  CLOUDFLARE_ACCOUNT_ID: Type.Optional(Type.String()),
  CLOUDFLARE_EMAIL_API_TOKEN: Type.Optional(Type.String()),
  AUTH_EMAIL_FROM: Type.Optional(Type.String()),
  AUTH_EMAIL_FROM_NAME: Type.Optional(Type.String()),
  AUTH_EMAIL_VERIFY_URL: Type.Optional(Type.String()),
  AUTH_PASSWORD_RESET_URL: Type.Optional(Type.String()),
  // Comma-separated AdMob ad unit ids (either the full `ca-app-pub-…/123` form or just `123`) whose
  // SSV callbacks may credit. Google signs SSV for every publisher with the same keys, so without
  // this list any AdMob app can aim its callback at us. Read through `admobAllowedAdUnits()`.
  ADMOB_ALLOWED_AD_UNITS: Type.Optional(Type.String()),
  // S3-compatible object storage (AWS S3, Cloudflare R2, SeaweedFS) for novel covers and import files.
  // Optional so dev/test can boot without it; upload endpoints fail with 503 until configured.
  S3_ENDPOINT: Type.Optional(Type.String()),
  S3_REGION: Type.Optional(Type.String()),
  S3_BUCKET: Type.Optional(Type.String()),
  S3_ACCESS_KEY_ID: Type.Optional(Type.String()),
  S3_SECRET_ACCESS_KEY: Type.Optional(Type.String()),
  S3_FORCE_PATH_STYLE: Type.Boolean({ default: false }),
  // Public (CDN) base URL objects are served from, e.g. https://cdn.example.com.
  S3_PUBLIC_BASE_URL: Type.Optional(Type.String()),
  // Base of the invite link GET /referral hands the app to share (the code is appended as /{code}).
  // Optional: without a registered deeplink/landing page there is no correct value, and the field is
  // omitted from the response rather than emitting a link that goes nowhere.
  REFERRAL_SHARE_BASE_URL: Type.Optional(Type.String()),
});

export type Env = Static<typeof EnvSchema>;

function integerEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error('Invalid environment configuration:\n  - /PORT: Expected integer');
  }
  return parsed;
}

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const candidate: Record<string, unknown> = {
    NODE_ENV: source['NODE_ENV'],
    PORT: integerEnv(source['PORT']),
    LOG_LEVEL: source['LOG_LEVEL'],
    DATABASE_URL: source['DATABASE_URL'],
    REDIS_URL: source['REDIS_URL'],
    JWT_ACCESS_SECRET: source['JWT_ACCESS_SECRET'],
    JWT_REFRESH_SECRET: source['JWT_REFRESH_SECRET'],
    DELIVERY_CODE_ENC_KEY: source['DELIVERY_CODE_ENC_KEY'],
    ADMIN_API_KEY: source['ADMIN_API_KEY'],
    ADMIN_CSRF_TOKEN: source['ADMIN_CSRF_TOKEN'],
    ENABLE_LEGACY_ADMIN_API_KEY: source['ENABLE_LEGACY_ADMIN_API_KEY'] === 'true',
    CMS_SESSION_SECRET: source['CMS_SESSION_SECRET'],
    ENABLE_TEST_COIN_API: source['ENABLE_TEST_COIN_API'] === 'true',
    TRUST_PROXY: source['TRUST_PROXY'],
    TAPJOY_POSTBACK_SECRET: source['TAPJOY_POSTBACK_SECRET'],
    PUBSCALE_POSTBACK_SECRET: source['PUBSCALE_POSTBACK_SECRET'],
    TAPJOY_PLACEMENT: source['TAPJOY_PLACEMENT'],
    PUBSCALE_PLACEMENT: source['PUBSCALE_PLACEMENT'],
    MIN_SUPPORTED_APP_VERSION: source['MIN_SUPPORTED_APP_VERSION'],
    GOOGLE_CLIENT_ID: source['GOOGLE_CLIENT_ID'],
    FACEBOOK_APP_ID: source['FACEBOOK_APP_ID'],
    FACEBOOK_APP_SECRET: source['FACEBOOK_APP_SECRET'],
    CLOUDFLARE_ACCOUNT_ID: source['CLOUDFLARE_ACCOUNT_ID'],
    CLOUDFLARE_EMAIL_API_TOKEN: source['CLOUDFLARE_EMAIL_API_TOKEN'],
    AUTH_EMAIL_FROM: source['AUTH_EMAIL_FROM'],
    AUTH_EMAIL_FROM_NAME: source['AUTH_EMAIL_FROM_NAME'],
    AUTH_EMAIL_VERIFY_URL: source['AUTH_EMAIL_VERIFY_URL'],
    AUTH_PASSWORD_RESET_URL: source['AUTH_PASSWORD_RESET_URL'],
    ADMOB_ALLOWED_AD_UNITS: source['ADMOB_ALLOWED_AD_UNITS'],
    S3_ENDPOINT: source['S3_ENDPOINT'],
    S3_REGION: source['S3_REGION'],
    S3_BUCKET: source['S3_BUCKET'],
    S3_ACCESS_KEY_ID: source['S3_ACCESS_KEY_ID'],
    S3_SECRET_ACCESS_KEY: source['S3_SECRET_ACCESS_KEY'],
    S3_FORCE_PATH_STYLE: source['S3_FORCE_PATH_STYLE'] === 'true',
    S3_PUBLIC_BASE_URL: source['S3_PUBLIC_BASE_URL'],
    REFERRAL_SHARE_BASE_URL: source['REFERRAL_SHARE_BASE_URL'],
  };

  // Cast coerces string env values (e.g. PORT="3000") into schema types and fills defaults;
  // it does not guarantee validity, so the explicit Check below is what actually enforces it.
  const cast = Value.Cast(EnvSchema, candidate) as unknown;

  if (!Value.Check(EnvSchema, cast)) {
    const errors = [...Value.Errors(EnvSchema, cast)]
      .map((err) => `  - ${err.path}: ${err.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${errors}`);
  }

  if (cast.NODE_ENV === 'production') {
    assertProductionSecrets(cast);
  }

  return cast;
}

const MIN_PRODUCTION_SECRET_LENGTH = 32;

// Dev/test keep accepting short placeholder secrets; production refuses to boot with secrets that
// are guessable or shared between the access and refresh token keys.
function assertProductionSecrets(config: Env): void {
  const problems: string[] = [];
  const secrets = {
    JWT_ACCESS_SECRET: config.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: config.JWT_REFRESH_SECRET,
    ADMIN_API_KEY: config.ADMIN_API_KEY,
  };
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length < MIN_PRODUCTION_SECRET_LENGTH) {
      problems.push(`  - /${name}: must be at least ${String(MIN_PRODUCTION_SECRET_LENGTH)} characters`);
    }
  }
  if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
    problems.push('  - /JWT_REFRESH_SECRET: must differ from JWT_ACCESS_SECRET');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
}

export const env: Env = loadEnv(process.env);

// Empty array means "not configured" — app.ts falls back to a stub provider that fails loudly only
// if a request is actually routed to Google.
export function googleClientIds(): string[] {
  return (env.GOOGLE_CLIENT_ID ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

// Empty array means "not configured" — the SSV handler then accepts any ad unit (and logs a warning
// at boot), which keeps existing deployments working until the list is filled in.
export function admobAllowedAdUnits(): string[] {
  return (env.ADMOB_ALLOWED_AD_UNITS ?? '')
    .split(',')
    .map((unit) => unit.trim())
    .filter((unit) => unit.length > 0)
    .map((unit) => unit.slice(unit.lastIndexOf('/') + 1));
}
