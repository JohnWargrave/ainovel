import crypto from 'node:crypto';
import { argon2id, hash as hashPassword, verify as verifyPassword } from 'argon2';
import { uuidv7 } from 'uuidv7';
import ipaddr from 'ipaddr.js';
import type { JWT } from '@fastify/jwt';
import type { Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { displayName } from '../../lib/display-name.js';
import { checkSubjectRateLimit } from '../../lib/rate-limit.js';
import { creditInTransaction } from '../wallet-ledger/ledger.service.js';
import { recordMint, recordRevenue } from '../wallet-ledger/economy-counters.js';
import { assignReferralCode } from '../referral/referral-code.js';
import {
  computeInstallationFingerprint,
  computeLegacyFingerprint,
  normalizeGaid,
} from './fingerprint.js';
import { resolveRegion } from './geo.js';
import { issueTokenPair, type SessionContext, type TokenPair } from './jwt.js';
import type { AuthProviders } from './ports.js';
import type { AuthEmailSender } from './auth-email.js';
import { recordAuthEvent, type AuthEventContext } from './auth-events.js';
import { getCoinRewardSettingsInTransaction } from '../config/coin-reward-settings.service.js';
import { activeBoost, type ActiveBoost } from '../spin/boost.service.js';

const RECOVER_RATE_LIMIT_WINDOW_S = 3_600;
const RECOVER_RATE_LIMIT_MAX = 5;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_HASH_OPTIONS = { type: argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 };
const DUMMY_PASSWORD_HASH = hashPassword('not-a-real-account-password', PASSWORD_HASH_OPTIONS);

export interface AuthDeps {
  providers: AuthProviders;
  accessJwt: JWT;
  refreshJwt: JWT;
  emailSender: AuthEmailSender;
}

export interface AuthRequestContext extends AuthEventContext, SessionContext {
  ip: string;
}

export interface DeviceInput {
  installationId: string;
  gaid: string | null;
  model: string;
  os: string;
  buildProps?: Record<string, string> | undefined;
  appVersion?: string | undefined;
}

export interface PublicUser {
  id: string;
  auth_provider: string;
  trust_level: number;
  region_id: string;
  country_code: string;
  referral_code: string | null;
  created_at: unknown;
}

export interface AuthResult extends TokenPair {
  user: PublicUser;
  // True when POST /auth/guest returned an existing account instead of creating one, so the app can
  // say "welcome back" rather than showing a first-run flow. Additive: /auth/guest declares no
  // response schema, so clients that ignore the field are unaffected.
  recovered?: boolean;
}

interface UserRow {
  id: string;
  auth_provider: string;
  auth_subject: string;
  email: string | null;
  country_code: string;
  region_id: string;
  trust_level: number;
  referral_code: string | null;
  created_at: unknown;
}

function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    auth_provider: user.auth_provider,
    trust_level: user.trust_level,
    region_id: user.region_id,
    country_code: user.country_code,
    referral_code: user.referral_code,
    created_at: user.created_at,
  };
}

// D01 (05-FRAUD-ENGINE.md §1): a fingerprint already bound to a user hard-blocks signup. Checked
// proactively so the caller gets a clean error and the existing owner gets flagged; the DB's
// devices_fingerprint_active unique index is the race-safe backstop for concurrent attempts.
//
// Runs against `db` (not the signup's `trx`) and outside `createUserWithDevice`'s transaction on
// purpose: the fraud_flags insert must survive even though the signup itself is aborted, and Kysely
// rolls back everything a transaction callback wrote once that callback throws — so writing the flag
// then throwing inside the same transaction as the user/wallet/device inserts would silently discard
// the flag along with the (correctly) aborted signup.
async function assertFingerprintFree(fingerprint: string): Promise<void> {
  const existingDevice = await db
    .selectFrom('devices')
    .select('user_id')
    .where('fingerprint_hash', '=', fingerprint)
    .executeTakeFirst();
  if (!existingDevice) return;

  await db
    .insertInto('fraud_flags')
    .values({
      id: uuidv7(),
      user_id: existingDevice.user_id,
      rule_code: 'D01',
      severity: 5,
      evidence: JSON.stringify({ blocked_signup_fingerprint: fingerprint }),
    })
    .execute();

  throw new AppError('SIGNUP_BLOCKED', 'Unable to create an account on this device', 409);
}

interface AuthCreditResult {
  regionId: string | null;
  mintedAmount: number;
  revenueUsd: number;
}

const EMPTY_AUTH_CREDIT: AuthCreditResult = {
  regionId: null,
  mintedAmount: 0,
  revenueUsd: 0,
};

async function ensureRewardCreditInTransaction(
  trx: Transaction<DB>,
  userId: string,
  entryType: 'WELCOME_CREDIT' | 'LOGIN_BIND_CREDIT',
  amount: number,
): Promise<AuthCreditResult> {
  if (amount === 0) return EMPTY_AUTH_CREDIT;

  const existing = await trx
    .selectFrom('coin_ledger')
    .select('id')
    .where('user_id', '=', userId)
    .where('entry_type', '=', entryType)
    .executeTakeFirst();
  if (existing) return EMPTY_AUTH_CREDIT;

  const googleLogin = entryType === 'LOGIN_BIND_CREDIT';
  return creditInTransaction(trx, {
    userId,
    entryType,
    amount,
    idempotencyKey: googleLogin ? `google-login:${userId}` : `welcome:${userId}`,
    note: googleLogin ? 'one-time Google login bonus' : 'one-time welcome bonus',
  });
}

async function ensureAuthCreditsInTransaction(
  trx: Transaction<DB>,
  userId: string,
  provider: string,
): Promise<AuthCreditResult> {
  // Serialize the ledger checks with all wallet credits. Older releases keyed welcome credit by
  // fingerprint, so checking by ledger type also prevents those accounts being paid twice.
  const wallet = await trx
    .selectFrom('wallets')
    .select('user_id')
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (!wallet) {
    throw new AppError('WALLET_NOT_FOUND', `No wallet for user ${userId}`, 404);
  }

  const settings = await getCoinRewardSettingsInTransaction(trx);
  const welcome = await ensureRewardCreditInTransaction(
    trx,
    userId,
    'WELCOME_CREDIT',
    settings.welcome_coin,
  );
  const google =
    provider === 'google'
      ? await ensureRewardCreditInTransaction(
          trx,
          userId,
          'LOGIN_BIND_CREDIT',
          settings.google_login,
        )
      : EMPTY_AUTH_CREDIT;

  return {
    regionId: google.regionId ?? welcome.regionId,
    mintedAmount: welcome.mintedAmount + google.mintedAmount,
    revenueUsd: welcome.revenueUsd + google.revenueUsd,
  };
}

interface CreateUserResult {
  user: UserRow;
  tokens: TokenPair;
  mintedRegionId: string | null;
  mintedAmount: number;
  mintedRevenueUsd: number;
}

// Shared by guest signup and OAuth (new-account) signup: insert user+wallet+device, run the D01
// fingerprint check, credit the one-time welcome bonus, and issue the token pair in one transaction.
async function createUserWithDevice(
  deps: AuthDeps,
  authProvider: string,
  authSubject: string,
  email: string | null,
  device: DeviceInput,
  context: AuthRequestContext,
  passwordCredential?: { username: string; email: string; passwordHash: string },
  identityEmailVerified = false,
): Promise<CreateUserResult> {
  const fingerprint = computeInstallationFingerprint(device.installationId);
  const gaid = normalizeGaid(device.gaid);
  const { countryCode, regionId } = resolveRegion(context.ip);
  await assertFingerprintFree(fingerprint);

  return db.transaction().execute(async (trx) => {
    const userId = uuidv7();
    const referralCode = await assignReferralCode(trx);
    await trx
      .insertInto('users')
      .values({
        id: userId,
        auth_provider: authProvider,
        auth_subject: authSubject,
        email,
        country_code: countryCode,
        region_id: regionId,
        referral_code: referralCode,
      })
      .execute();

    await trx.insertInto('wallets').values({ user_id: userId }).execute();

    if (authProvider !== 'password') {
      await trx
        .insertInto('user_identities')
        .values({
          id: uuidv7(),
          user_id: userId,
          provider: authProvider,
          provider_subject: authSubject,
          email,
          email_verified_at: identityEmailVerified && email !== null ? new Date() : null,
        })
        .execute();
    }

    if (passwordCredential) {
      await trx
        .insertInto('password_credentials')
        .values({
          user_id: userId,
          username: passwordCredential.username,
          email: passwordCredential.email,
          password_hash: passwordCredential.passwordHash,
          email_verified_at: null,
        })
        .execute();
    }

    await trx
      .insertInto('devices')
      .values({
        id: uuidv7(),
        user_id: userId,
        fingerprint_hash: fingerprint,
        installation_id: device.installationId,
        gaid,
        model: device.model,
        os_version: device.os,
        app_version: device.appVersion ?? null,
        play_integrity_verdict: null,
      })
      .execute();

    const creditResult = await ensureAuthCreditsInTransaction(trx, userId, authProvider);

    const tokens = await issueTokenPair(deps.accessJwt, deps.refreshJwt, userId, 0, trx, {
      ...context,
      provider: authProvider,
    });

    await recordAuthEvent(
      {
        ...context,
        userId,
        provider: authProvider,
        eventType: 'register',
        outcome: 'success',
      },
      trx,
    );

    const user: UserRow = {
      id: userId,
      auth_provider: authProvider,
      auth_subject: authSubject,
      email,
      country_code: countryCode,
      region_id: regionId,
      trust_level: 0,
      referral_code: referralCode,
      created_at: new Date(),
    };

    return {
      user,
      tokens,
      mintedRegionId: creditResult.regionId,
      mintedAmount: creditResult.mintedAmount,
      mintedRevenueUsd: creditResult.revenueUsd,
    };
  });
}

function fireEconomyCounters(regionId: string | null, amount: number, revenueUsd: number): void {
  if (!regionId) return;
  void recordMint(regionId, amount).catch(() => undefined);
  void recordRevenue(regionId, revenueUsd).catch(() => undefined);
}

// Guest recovery is keyed by the random installation ID persisted by the app. It is not a credential:
// users who clear app data lose it, so binding a durable login method remains the recovery path.
// Legacy GAID/model/OS fingerprints are accepted once solely to migrate existing guest balances.
//
// Returns null when the caller should fall through to the normal signup path (including the D01
// block) — an unknown device, or a device whose owner is banned/suspended.
async function tryRecoverGuest(
  deps: AuthDeps,
  fingerprint: string,
  device: DeviceInput,
  legacyFingerprint: string | null,
  context: AuthRequestContext,
): Promise<AuthResult | null> {
  let owner = await db
    .selectFrom('devices')
    .innerJoin('users', 'users.id', 'devices.user_id')
    .select([
      'users.id as id',
      'users.auth_provider as auth_provider',
      'users.auth_subject as auth_subject',
      'users.email as email',
      'users.country_code as country_code',
      'users.region_id as region_id',
      'users.trust_level as trust_level',
      'users.referral_code as referral_code',
      'users.created_at as created_at',
      'users.status as status',
      'devices.id as device_row_id',
      'devices.fingerprint_hash as device_fingerprint_hash',
    ])
    .where('devices.fingerprint_hash', '=', fingerprint)
    .orderBy('devices.first_seen_at', 'asc')
    .executeTakeFirst();

  if (!owner && legacyFingerprint) {
    owner = await db
      .selectFrom('devices')
      .innerJoin('users', 'users.id', 'devices.user_id')
      .select([
        'users.id as id',
        'users.auth_provider as auth_provider',
        'users.auth_subject as auth_subject',
        'users.email as email',
        'users.country_code as country_code',
        'users.region_id as region_id',
        'users.trust_level as trust_level',
        'users.referral_code as referral_code',
        'users.created_at as created_at',
        'users.status as status',
        'devices.id as device_row_id',
        'devices.fingerprint_hash as device_fingerprint_hash',
      ])
      .where('devices.fingerprint_hash', '=', legacyFingerprint)
      .orderBy('devices.first_seen_at', 'asc')
      .executeTakeFirst();
  }

  if (!owner) return null;
  // A banned or suspended owner keeps the old behaviour: no tokens, and the D01 flag still lands.
  if (owner.status !== 'active') return null;

  const usableCredential = await db
    .selectFrom('user_identities')
    .select('id')
    .where('user_id', '=', owner.id)
    .where('provider', '!=', 'guest')
    .where('disabled_at', 'is', null)
    .executeTakeFirst();
  const passwordCredential = await db
    .selectFrom('password_credentials')
    .select('user_id')
    .where('user_id', '=', owner.id)
    .where('disabled_at', 'is', null)
    .executeTakeFirst();
  if (usableCredential || passwordCredential) {
    // The account outgrew guest mode. Handing out tokens on a fingerprint alone would bypass the
    // provider check the user deliberately added, so point the app at the sign-in button instead.
    throw new AppError(
      'SIGNUP_USE_OAUTH',
      'This device is already linked to an account — sign in with your linked provider',
      409,
    );
  }

  // Per-fingerprint budget on top of the route's per-IP one: a handset legitimately recovers once
  // after a reinstall, so anything approaching this rate is someone replaying a guessed fingerprint.
  await checkSubjectRateLimit(
    'auth-guest-recover',
    fingerprint,
    RECOVER_RATE_LIMIT_WINDOW_S,
    RECOVER_RATE_LIMIT_MAX,
  );

  const outcome = await db.transaction().execute(async (trx) => {
    if (owner.device_fingerprint_hash !== fingerprint) {
      const deviceRow = await trx
        .selectFrom('devices')
        .select(['fingerprint_hash', 'installation_id'])
        .where('id', '=', owner.device_row_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        deviceRow.fingerprint_hash !== owner.device_fingerprint_hash ||
        (deviceRow.installation_id !== null && deviceRow.installation_id !== device.installationId)
      ) {
        throw new AppError(
          'DEVICE_IDENTITY_CONFLICT',
          'This guest account was already migrated; sign in again',
          409,
        );
      }

      await trx
        .updateTable('user_identities')
        .set({ provider_subject: fingerprint, last_used_at: new Date() })
        .where('user_id', '=', owner.id)
        .where('provider', '=', 'guest')
        .execute();
      await trx
        .updateTable('users')
        .set({ auth_subject: fingerprint, updated_at: new Date() })
        .where('id', '=', owner.id)
        .where('auth_provider', '=', 'guest')
        .execute();
    }

    await trx
      .updateTable('devices')
      .set({
        fingerprint_hash: fingerprint,
        installation_id: device.installationId,
        gaid: normalizeGaid(device.gaid),
        model: device.model,
        os_version: device.os,
        app_version: device.appVersion ?? null,
        last_seen_at: new Date(),
      })
      .where('id', '=', owner.device_row_id)
      .execute();

    const creditResult = await ensureAuthCreditsInTransaction(trx, owner.id, 'guest');
    const tokens = await issueTokenPair(
      deps.accessJwt,
      deps.refreshJwt,
      owner.id,
      owner.trust_level,
      trx,
      { ...context, provider: 'guest' },
    );

    // No fraud_flags row: this is the account's owner coming back, not a second account on one
    // device. Audited instead, so a takeover attempt is still reconstructable after the fact.
    await trx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: null,
        action: 'GUEST_SESSION_RECOVERED',
        target_type: 'user',
        target_id: owner.id,
        detail: JSON.stringify({
          installation_fingerprint: fingerprint,
          legacy_migrated: owner.device_fingerprint_hash !== fingerprint,
        }),
        ip: null,
      })
      .execute();

    await recordAuthEvent(
      {
        ...context,
        userId: owner.id,
        provider: 'guest',
        eventType: 'login',
        outcome: 'success',
        metadata: { recovered: true },
      },
      trx,
    );

    return { creditResult, tokens };
  });
  fireEconomyCounters(
    outcome.creditResult.regionId,
    outcome.creditResult.mintedAmount,
    outcome.creditResult.revenueUsd,
  );

  return {
    access: outcome.tokens.access,
    refresh: outcome.tokens.refresh,
    user: toPublicUser(owner),
    recovered: true,
  };
}

const GUEST_CREATE_WINDOW_S = 60 * 60;
const GUEST_CREATE_PER_NETWORK_MAX = 60;
const GUEST_CREATE_GAID_WINDOW_S = 24 * 60 * 60;
const GUEST_CREATE_PER_GAID_MAX = 3;

function networkKey(ip: string): string {
  if (!ipaddr.isValid(ip)) return ip;
  const parsed = ipaddr.process(ip);
  if (parsed.kind() === 'ipv4') {
    return `${parsed.toByteArray().slice(0, 3).join('.')}.0/24`;
  }
  return `${(parsed as ipaddr.IPv6).parts.slice(0, 4).map((part) => part.toString(16)).join(':')}::/64`;
}

export async function guestSignup(
  deps: AuthDeps,
  device: DeviceInput,
  context: AuthRequestContext,
): Promise<AuthResult> {
  // Guest identity is scoped to one app installation. GAID is optional fraud/attribution metadata
  // and is used only for a one-time lookup of accounts created before installation IDs existed.
  const fingerprintForSubject = computeInstallationFingerprint(device.installationId);
  const gaid = normalizeGaid(device.gaid);
  const legacyFingerprint = gaid
    ? computeLegacyFingerprint({
        gaid,
        model: device.model,
        os: device.os,
        buildProps: device.buildProps,
      })
    : null;
  const recovered = await tryRecoverGuest(
    deps,
    fingerprintForSubject,
    device,
    legacyFingerprint,
    context,
  );
  if (recovered) return recovered;

  // New-account budgets, separate from the per-IP request limit on the route: X-Device-Id is
  // client-generated, so without these a script can mint a fresh account (and welcome bonus) per
  // request. Keyed on the /24 (IPv4) or /64 (IPv6) so rotating addresses inside one network does
  // not reset the budget.
  await checkSubjectRateLimit(
    'auth-guest-create-net',
    networkKey(context.ip),
    GUEST_CREATE_WINDOW_S,
    GUEST_CREATE_PER_NETWORK_MAX,
  );
  if (gaid) {
    await checkSubjectRateLimit(
      'auth-guest-create-gaid',
      gaid,
      GUEST_CREATE_GAID_WINDOW_S,
      GUEST_CREATE_PER_GAID_MAX,
    );
  }

  const result = await createUserWithDevice(
    deps,
    'guest',
    fingerprintForSubject,
    null,
    device,
    context,
  );
  fireEconomyCounters(result.mintedRegionId, result.mintedAmount, result.mintedRevenueUsd);
  return {
    access: result.tokens.access,
    refresh: result.tokens.refresh,
    user: toPublicUser(result.user),
  };
}

export async function oauthAuthenticate(
  deps: AuthDeps,
  providerName: 'google' | 'facebook',
  idToken: string,
  device: DeviceInput,
  context: AuthRequestContext,
): Promise<AuthResult> {
  let identity;
  try {
    identity = await deps.providers[providerName].verify(idToken);
  } catch (error) {
    await recordAuthEvent({
      ...context,
      provider: providerName,
      eventType: 'login',
      outcome: 'failure',
      failureCode: 'INVALID_ID_TOKEN',
    });
    throw error;
  }

  const existing = await db
    .selectFrom('user_identities')
    .innerJoin('users', 'users.id', 'user_identities.user_id')
    .selectAll('users')
    .select('user_identities.disabled_at as identity_disabled_at')
    .where('user_identities.provider', '=', providerName)
    .where('user_identities.provider_subject', '=', identity.subject)
    .executeTakeFirst();

  if (existing) {
    if (existing.identity_disabled_at !== null) {
      await recordAuthEvent({
        ...context,
        userId: existing.id,
        provider: providerName,
        eventType: 'login',
        outcome: 'failure',
        failureCode: 'CREDENTIAL_DISABLED',
      });
      throw new AppError('CREDENTIAL_DISABLED', 'This login method is disabled', 403);
    }
    if (existing.status !== 'active') {
      await recordAuthEvent({
        ...context,
        userId: existing.id,
        provider: providerName,
        eventType: 'login',
        outcome: 'failure',
        failureCode: 'ACCOUNT_NOT_ACTIVE',
      });
      throw new AppError('ACCOUNT_NOT_ACTIVE', 'Account is not active', 403);
    }
    // A returning account that predates this rule receives its missing welcome bonus on login.
    // Existing recipients are detected by ledger type, so repeated logins never mint it again.
    const outcome = await db.transaction().execute(async (trx) => {
      const creditResult = await ensureAuthCreditsInTransaction(trx, existing.id, providerName);
      const tokens = await issueTokenPair(
        deps.accessJwt,
        deps.refreshJwt,
        existing.id,
        existing.trust_level,
        trx,
        { ...context, provider: providerName },
      );
      await trx
        .updateTable('user_identities')
        .set({ last_used_at: new Date(), email: identity.email })
        .where('provider', '=', providerName)
        .where('provider_subject', '=', identity.subject)
        .execute();
      await recordAuthEvent(
        {
          ...context,
          userId: existing.id,
          provider: providerName,
          eventType: 'login',
          outcome: 'success',
        },
        trx,
      );
      return { creditResult, tokens };
    });
    fireEconomyCounters(
      outcome.creditResult.regionId,
      outcome.creditResult.mintedAmount,
      outcome.creditResult.revenueUsd,
    );
    return {
      access: outcome.tokens.access,
      refresh: outcome.tokens.refresh,
      user: toPublicUser(existing),
    };
  }

  const result = await createUserWithDevice(
    deps,
    providerName,
    identity.subject,
    identity.email,
    device,
    context,
    undefined,
    identity.emailVerified === true,
  );
  fireEconomyCounters(result.mintedRegionId, result.mintedAmount, result.mintedRevenueUsd);
  return {
    access: result.tokens.access,
    refresh: result.tokens.refresh,
    user: toPublicUser(result.user),
  };
}

export async function bindIdentity(
  deps: AuthDeps,
  userId: string,
  providerName: 'google' | 'facebook',
  idToken: string,
  context: AuthRequestContext,
): Promise<AuthResult> {
  const identity = await deps.providers[providerName].verify(idToken);

  const outcome = await db.transaction().execute(async (trx) => {
    const takenBy = await trx
      .selectFrom('user_identities')
      .select('user_id')
      .where('provider', '=', providerName)
      .where('provider_subject', '=', identity.subject)
      .executeTakeFirst();
    if (takenBy && takenBy.user_id !== userId) {
      throw new AppError('IDENTITY_TAKEN', 'This account is already linked to another user', 409);
    }

    const user = await trx
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!user) {
      throw new AppError('USER_NOT_FOUND', `No user ${userId}`, 404);
    }
    const existingProvider = await trx
      .selectFrom('user_identities')
      .select('id')
      .where('user_id', '=', userId)
      .where('provider', '=', providerName)
      .executeTakeFirst();
    if (existingProvider) {
      throw new AppError('ALREADY_BOUND', 'This login method is already linked', 409);
    }

    await trx
      .insertInto('user_identities')
      .values({
        id: uuidv7(),
        user_id: userId,
        provider: providerName,
        provider_subject: identity.subject,
        email: identity.email,
        email_verified_at:
          identity.emailVerified === true && identity.email !== null ? new Date() : null,
      })
      .execute();

    await trx
      .updateTable('users')
      .set({
        auth_provider: providerName,
        auth_subject: identity.subject,
        email: identity.email ?? user.email,
        updated_at: new Date(),
      })
      .where('id', '=', userId)
      .execute();

    const authCreditResult = await ensureAuthCreditsInTransaction(trx, userId, providerName);

    const tokens = await issueTokenPair(
      deps.accessJwt,
      deps.refreshJwt,
      userId,
      user.trust_level,
      trx,
      { ...context, provider: providerName },
    );

    await recordAuthEvent(
      {
        ...context,
        userId,
        provider: providerName,
        eventType: 'identity_link',
        outcome: 'success',
      },
      trx,
    );

    const updatedUser: UserRow = {
      ...user,
      auth_provider: providerName,
      auth_subject: identity.subject,
      email: identity.email ?? user.email,
    };

    return { updatedUser, tokens, authCreditResult };
  });

  fireEconomyCounters(
    outcome.authCreditResult.regionId,
    outcome.authCreditResult.mintedAmount,
    outcome.authCreditResult.revenueUsd,
  );
  return {
    access: outcome.tokens.access,
    refresh: outcome.tokens.refresh,
    user: toPublicUser(outcome.updatedUser),
  };
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

async function createVerificationToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await db
    .insertInto('email_verification_tokens')
    .values({
      id: uuidv7(),
      user_id: userId,
      token_hash: tokenHash(token),
      expires_at: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
    })
    .execute();
  return token;
}

export async function passwordRegister(
  deps: AuthDeps,
  input: { username: string; email: string; password: string },
  device: DeviceInput,
  context: AuthRequestContext,
): Promise<AuthResult> {
  const username = normalizeUsername(input.username);
  const email = normalizeEmail(input.email);
  const passwordDigest = await hashPassword(input.password, PASSWORD_HASH_OPTIONS);

  let result: CreateUserResult;
  try {
    result = await createUserWithDevice(deps, 'password', username, email, device, context, {
      username,
      email,
      passwordHash: passwordDigest,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      await recordAuthEvent({
        ...context,
        provider: 'password',
        eventType: 'register',
        outcome: 'failure',
        failureCode: 'CREDENTIAL_UNAVAILABLE',
      });
      throw new AppError('CREDENTIAL_UNAVAILABLE', 'Username or email is already in use', 409);
    }
    throw error;
  }

  const verificationToken = await createVerificationToken(result.user.id);
  void deps.emailSender.sendVerification(email, verificationToken).catch(() => undefined);
  fireEconomyCounters(result.mintedRegionId, result.mintedAmount, result.mintedRevenueUsd);
  return { ...result.tokens, user: toPublicUser(result.user) };
}

export async function passwordLogin(
  deps: AuthDeps,
  usernameInput: string,
  password: string,
  context: AuthRequestContext,
): Promise<AuthResult> {
  const username = normalizeUsername(usernameInput);
  const credential = await db
    .selectFrom('password_credentials')
    .innerJoin('users', 'users.id', 'password_credentials.user_id')
    .select([
      'users.id',
      'users.auth_provider',
      'users.auth_subject',
      'users.email',
      'users.country_code',
      'users.region_id',
      'users.trust_level',
      'users.referral_code',
      'users.created_at',
      'users.status',
      'password_credentials.password_hash',
      'password_credentials.disabled_at',
    ])
    .where((eb) => eb.fn('lower', ['password_credentials.username']), '=', username)
    .executeTakeFirst();

  const digest = credential?.password_hash ?? (await DUMMY_PASSWORD_HASH);
  const valid = await verifyPassword(digest, password).catch(() => false);
  if (!credential || !valid || credential.disabled_at !== null) {
    await recordAuthEvent({
      ...context,
      userId: credential?.id,
      provider: 'password',
      eventType: 'login',
      outcome: 'failure',
      failureCode: 'INVALID_CREDENTIALS',
    });
    throw new AppError('INVALID_CREDENTIALS', 'Invalid username or password', 401);
  }
  if (credential.status !== 'active') {
    await recordAuthEvent({
      ...context,
      userId: credential.id,
      provider: 'password',
      eventType: 'login',
      outcome: 'failure',
      failureCode: 'ACCOUNT_NOT_ACTIVE',
    });
    throw new AppError('ACCOUNT_NOT_ACTIVE', 'Account is not active', 403);
  }

  const outcome = await db.transaction().execute(async (trx) => {
    const creditResult = await ensureAuthCreditsInTransaction(trx, credential.id, 'password');
    const tokens = await issueTokenPair(
      deps.accessJwt,
      deps.refreshJwt,
      credential.id,
      credential.trust_level,
      trx,
      { ...context, provider: 'password' },
    );
    await recordAuthEvent(
      {
        ...context,
        userId: credential.id,
        provider: 'password',
        eventType: 'login',
        outcome: 'success',
      },
      trx,
    );
    return { creditResult, tokens };
  });
  fireEconomyCounters(
    outcome.creditResult.regionId,
    outcome.creditResult.mintedAmount,
    outcome.creditResult.revenueUsd,
  );
  return { ...outcome.tokens, user: toPublicUser(credential) };
}

export async function bindPasswordCredential(
  deps: AuthDeps,
  userId: string,
  input: { username: string; email: string; password: string },
  context: AuthRequestContext,
): Promise<void> {
  const username = normalizeUsername(input.username);
  const email = normalizeEmail(input.email);
  const passwordDigest = await hashPassword(input.password, PASSWORD_HASH_OPTIONS);
  try {
    const creditResult = await db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select(['id', 'auth_provider', 'email'])
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!user) throw new AppError('USER_NOT_FOUND', 'User not found', 404);
      const existing = await trx
        .selectFrom('password_credentials')
        .select('user_id')
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (existing) throw new AppError('ALREADY_BOUND', 'Password login is already linked', 409);
      await trx
        .insertInto('password_credentials')
        .values({ user_id: userId, username, email, password_hash: passwordDigest })
        .execute();
      if (user.auth_provider === 'guest') {
        await trx
          .updateTable('users')
          .set({
            auth_provider: 'password',
            auth_subject: username,
            email,
            updated_at: new Date(),
          })
          .where('id', '=', userId)
          .execute();
      }
      const welcomeResult = await ensureAuthCreditsInTransaction(trx, userId, 'password');
      await recordAuthEvent(
        {
          ...context,
          userId,
          provider: 'password',
          eventType: 'identity_link',
          outcome: 'success',
        },
        trx,
      );
      return welcomeResult;
    });
    fireEconomyCounters(creditResult.regionId, creditResult.mintedAmount, creditResult.revenueUsd);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError('CREDENTIAL_UNAVAILABLE', 'Username or email is already in use', 409);
    }
    throw error;
  }
  const verificationToken = await createVerificationToken(userId);
  void deps.emailSender.sendVerification(email, verificationToken).catch(() => undefined);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  context: AuthRequestContext,
): Promise<void> {
  const credential = await db
    .selectFrom('password_credentials')
    .select(['password_hash', 'disabled_at'])
    .where('user_id', '=', userId)
    .executeTakeFirst();
  const currentPasswordValid = credential
    ? await verifyPassword(credential.password_hash, currentPassword).catch(() => false)
    : false;
  if (credential?.disabled_at !== null || !currentPasswordValid) {
    await recordAuthEvent({
      ...context,
      userId,
      provider: 'password',
      eventType: 'password_change',
      outcome: 'failure',
      failureCode: 'INVALID_CREDENTIALS',
    });
    throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect', 401);
  }
  const nextHash = await hashPassword(newPassword, PASSWORD_HASH_OPTIONS);
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('password_credentials')
      .set({ password_hash: nextHash, password_changed_at: new Date() })
      .where('user_id', '=', userId)
      .execute();
    await trx
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date(), revocation_reason: 'password_changed' })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
    await recordAuthEvent(
      {
        ...context,
        userId,
        provider: 'password',
        eventType: 'password_change',
        outcome: 'success',
      },
      trx,
    );
  });
}

export async function requestPasswordReset(
  deps: AuthDeps,
  emailInput: string,
  context: AuthRequestContext,
): Promise<void> {
  const email = normalizeEmail(emailInput);
  const credential = await db
    .selectFrom('password_credentials')
    .select(['user_id', 'email', 'email_verified_at', 'disabled_at'])
    .where((eb) => eb.fn('lower', ['email']), '=', email)
    .executeTakeFirst();
  if (credential?.disabled_at !== null || credential.email_verified_at === null) {
    await recordAuthEvent({
      ...context,
      userId: credential?.user_id,
      provider: 'password',
      eventType: 'password_reset_request',
      outcome: 'failure',
      failureCode: 'NOT_ELIGIBLE',
    });
    return;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('password_reset_tokens')
      .set({ used_at: new Date() })
      .where('user_id', '=', credential.user_id)
      .where('used_at', 'is', null)
      .execute();
    await trx
      .insertInto('password_reset_tokens')
      .values({
        id: uuidv7(),
        user_id: credential.user_id,
        token_hash: tokenHash(token),
        expires_at: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      })
      .execute();
    await recordAuthEvent(
      {
        ...context,
        userId: credential.user_id,
        provider: 'password',
        eventType: 'password_reset_request',
        outcome: 'success',
      },
      trx,
    );
  });
  await deps.emailSender.sendPasswordReset(credential.email, token).catch(() => undefined);
}

export async function resetPassword(
  token: string,
  newPassword: string,
  context: AuthRequestContext,
): Promise<void> {
  const nextHash = await hashPassword(newPassword, PASSWORD_HASH_OPTIONS);
  const outcome = await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('password_reset_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash(token))
      .forUpdate()
      .executeTakeFirst();
    if (row?.used_at !== null || new Date(row.expires_at) <= new Date()) return null;
    const credential = await trx
      .selectFrom('password_credentials')
      .select('disabled_at')
      .where('user_id', '=', row.user_id)
      .executeTakeFirst();
    if (credential?.disabled_at !== null) return null;

    await trx
      .updateTable('password_credentials')
      .set({ password_hash: nextHash, password_changed_at: new Date() })
      .where('user_id', '=', row.user_id)
      .execute();
    await trx
      .updateTable('password_reset_tokens')
      .set({ used_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    await trx
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date(), revocation_reason: 'password_reset' })
      .where('user_id', '=', row.user_id)
      .where('revoked_at', 'is', null)
      .execute();
    await recordAuthEvent(
      {
        ...context,
        userId: row.user_id,
        provider: 'password',
        eventType: 'password_reset',
        outcome: 'success',
      },
      trx,
    );
    return row.user_id;
  });
  if (!outcome) {
    await recordAuthEvent({
      ...context,
      provider: 'password',
      eventType: 'password_reset',
      outcome: 'failure',
      failureCode: 'INVALID_RESET_TOKEN',
    });
    throw new AppError('INVALID_RESET_TOKEN', 'Reset token is invalid or expired', 400);
  }
}

export async function verifyPasswordEmail(
  token: string,
  context: AuthRequestContext,
): Promise<void> {
  const outcome = await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('email_verification_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash(token))
      .forUpdate()
      .executeTakeFirst();
    if (row?.used_at !== null || new Date(row.expires_at) <= new Date()) return null;
    await trx
      .updateTable('password_credentials')
      .set({ email_verified_at: new Date() })
      .where('user_id', '=', row.user_id)
      .execute();
    await trx
      .updateTable('email_verification_tokens')
      .set({ used_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    await recordAuthEvent(
      {
        ...context,
        userId: row.user_id,
        provider: 'password',
        eventType: 'email_verify',
        outcome: 'success',
      },
      trx,
    );
    return row.user_id;
  });
  if (!outcome)
    throw new AppError(
      'INVALID_VERIFICATION_TOKEN',
      'Verification token is invalid or expired',
      400,
    );
}

export async function getUserProfile(userId: string): Promise<{
  id: string;
  username: string;
  avatar_url: string | null;
  auth_provider: string;
  trust_level: number;
  region_id: string;
  referral_code: string | null;
  wallet: { available_coin: string; pending_coin: string };
  active_boost: ActiveBoost | null;
}> {
  const row = await db
    .selectFrom('users')
    .innerJoin('wallets', 'wallets.user_id', 'users.id')
    .leftJoin('password_credentials', 'password_credentials.user_id', 'users.id')
    .select([
      'users.id',
      'users.auth_provider',
      'users.trust_level',
      'users.region_id',
      'users.referral_code',
      'password_credentials.username as password_username',
      'wallets.available_coin',
      'wallets.pending_coin',
    ])
    .where('users.id', '=', userId)
    .executeTakeFirst();

  if (!row) {
    throw new AppError('USER_NOT_FOUND', 'User not found', 404);
  }

  return {
    id: row.id,
    username: row.password_username ?? displayName(userId),
    avatar_url: null,
    auth_provider: row.auth_provider,
    trust_level: row.trust_level,
    region_id: row.region_id,
    referral_code: row.referral_code,
    wallet: {
      available_coin: row.available_coin,
      pending_coin: row.pending_coin,
    },
    active_boost: await activeBoost(db, userId),
  };
}
