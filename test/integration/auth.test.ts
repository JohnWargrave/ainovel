import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { rateLimitRedis } from '../../src/redis/index.js';
import {
  computeInstallationFingerprint,
  computeLegacyFingerprint,
} from '../../src/modules/auth/fingerprint.js';
import { fakeIdentityProvider } from '../helpers/fake-providers.js';

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

interface TestDevice {
  gaid: string | null;
  model: string;
  os: string;
}

function registrationHeaders(installationId: string = randomUUID()): typeof APP_HEADERS {
  return { ...APP_HEADERS, 'x-device-id': installationId };
}

function randomDevice(overrides: Partial<TestDevice> = {}): TestDevice {
  return {
    gaid: randomUUID(),
    model: 'Pixel-Test',
    os: 'Android 14',
    ...overrides,
  };
}

function fingerprintOf(installationId: string): string {
  return computeInstallationFingerprint(installationId);
}

interface AuthResponseBody {
  access: string;
  refresh: string;
  recovered?: boolean;
  user: { id: string; public_id: string; auth_provider: string; trust_level: number };
}

interface TokenPairBody {
  access: string;
  refresh: string;
}

interface WalletResponseBody {
  available_coin: string;
}

interface ErrorResponseBody {
  error: { code: string; message: string };
}

describe('auth flow', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      providers: {
        google: fakeIdentityProvider(),
        facebook: fakeIdentityProvider(),
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('guest signup creates a user and credits WELCOME_CREDIT once', async () => {
    const device = randomDevice({ gaid: null });
    const installationId = randomUUID();

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers: registrationHeaders(installationId),
      payload: { device },
    });
    expect(signupRes.statusCode).toBe(200);
    const body = signupRes.json<AuthResponseBody>();
    expect(body.access).toBeTypeOf('string');
    expect(body.refresh).toBeTypeOf('string');
    expect(body.user.trust_level).toBe(0);
    expect(body.user.auth_provider).toBe('guest');
    expect(body.user.public_id).toMatch(/^[1-9]\d{7,}$/);
    expect(body.recovered).toBeUndefined();

    const walletRes = await app.inject({
      method: 'GET',
      url: '/wallet',
      headers: { ...APP_HEADERS, authorization: `Bearer ${body.access}` },
    });
    expect(walletRes.statusCode).toBe(200);
    expect(walletRes.json<WalletResponseBody>().available_coin).toBe('10000');

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { ...APP_HEADERS, authorization: `Bearer ${body.access}` },
    });
    expect(me.json<{ public_id: string }>().public_id).toBe(body.user.public_id);
    expect(me.json<{ welcome: unknown }>().welcome).toEqual({
      coin: 10_000,
      claimed: true,
      mode: 'instant',
    });

    const users = await db
      .selectFrom('users')
      .selectAll()
      .where('auth_subject', '=', fingerprintOf(installationId))
      .execute();
    expect(users).toHaveLength(1);

    const storedDevice = await db
      .selectFrom('devices')
      .select(['installation_id', 'gaid'])
      .where('user_id', '=', body.user.id)
      .executeTakeFirstOrThrow();
    expect(storedDevice).toEqual({ installation_id: installationId, gaid: null });
  });

  it('recovers the same guest when GAID, model, and OS change on one installation', async () => {
    const device = randomDevice();
    const headers = registrationHeaders();
    const updatedDevice = randomDevice({ model: 'Galaxy-Test', os: 'Android 16' });
    const first = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers,
      payload: { device },
    });
    const firstBody = first.json<AuthResponseBody>();

    const second = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers,
      payload: { device: updatedDevice },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<AuthResponseBody>();
    expect(secondBody.user.id).toBe(firstBody.user.id);
    expect(secondBody.user.public_id).toBe(firstBody.user.public_id);
    expect(secondBody.recovered).toBe(true);
    // A fresh refresh token is issued (access tokens are claim-identical within the same second).
    expect(secondBody.refresh).not.toBe(firstBody.refresh);

    const storedDevice = await db
      .selectFrom('devices')
      .select(['gaid', 'model', 'os_version'])
      .where('user_id', '=', firstBody.user.id)
      .executeTakeFirstOrThrow();
    expect(storedDevice).toEqual({
      gaid: updatedDevice.gaid,
      model: updatedDevice.model,
      os_version: updatedDevice.os,
    });

    // Balance survives the reinstall, and the welcome bonus is not paid a second time.
    const walletRes = await app.inject({
      method: 'GET',
      url: '/wallet',
      headers: { ...APP_HEADERS, authorization: `Bearer ${secondBody.access}` },
    });
    expect(walletRes.json<WalletResponseBody>().available_coin).toBe('10000');

    // The owner coming back is not multi-accounting: no D01, but an audit trail either way.
    const flags = await db
      .selectFrom('fraud_flags')
      .selectAll()
      .where('user_id', '=', firstBody.user.id)
      .where('rule_code', '=', 'D01')
      .execute();
    expect(flags).toHaveLength(0);

    const audits = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'GUEST_SESSION_RECOVERED')
      .where('target_id', '=', firstBody.user.id)
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.admin_user_id).toBeNull();
  });

  it('keeps separate guest accounts for two installations that share one GAID', async () => {
    const sharedGaid = randomUUID();
    const device = randomDevice({ gaid: sharedGaid });
    const first = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers: registrationHeaders(),
      payload: { device },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers: registrationHeaders(),
      payload: { device },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json<AuthResponseBody>().user.id).not.toBe(
      first.json<AuthResponseBody>().user.id,
    );
  });

  it('migrates a legacy GAID guest to installation identity without losing its account or balance', async () => {
    const gaid = randomUUID();
    const device = randomDevice({ gaid });
    const oldInstallationId = randomUUID();
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers: registrationHeaders(oldInstallationId),
      payload: { device },
    });
    expect(signup.statusCode).toBe(200);
    const original = signup.json<AuthResponseBody>();
    const legacyFingerprint = computeLegacyFingerprint({
      gaid,
      model: device.model,
      os: device.os,
    });

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('devices')
        .set({ fingerprint_hash: legacyFingerprint, installation_id: null })
        .where('user_id', '=', original.user.id)
        .execute();
      await trx
        .updateTable('users')
        .set({ auth_subject: legacyFingerprint })
        .where('id', '=', original.user.id)
        .execute();
      await trx
        .updateTable('user_identities')
        .set({ provider_subject: legacyFingerprint })
        .where('user_id', '=', original.user.id)
        .where('provider', '=', 'guest')
        .execute();
      await trx
        .updateTable('wallets')
        .set({ available_coin: 12_345 })
        .where('user_id', '=', original.user.id)
        .execute();
    });

    const newInstallationId = randomUUID();
    const migrated = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers: registrationHeaders(newInstallationId),
      payload: { device },
    });
    expect(migrated.statusCode).toBe(200);
    const migratedBody = migrated.json<AuthResponseBody>();
    expect(migratedBody.user.id).toBe(original.user.id);
    expect(migratedBody.recovered).toBe(true);

    const stored = await db
      .selectFrom('devices')
      .select(['installation_id', 'fingerprint_hash'])
      .where('user_id', '=', original.user.id)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({
      installation_id: newInstallationId,
      fingerprint_hash: fingerprintOf(newInstallationId),
    });
    const wallet = await db
      .selectFrom('wallets')
      .select('available_coin')
      .where('user_id', '=', original.user.id)
      .executeTakeFirstOrThrow();
    expect(wallet.available_coin).toBe('12345');
  });

  it.each(['not-a-uuid', '00000000-0000-0000-0000-000000000000'])(
    'rejects invalid installation ID %s',
    async (installationId) => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/guest',
        headers: registrationHeaders(installationId),
        payload: { device: randomDevice({ gaid: null }) },
      });
      expect(response.statusCode).toBe(400);
    },
  );

  it('directs a device whose account is OAuth-bound to sign in instead of recovering', async () => {
    const device = randomDevice();
    const headers = registrationHeaders();
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers,
      payload: { device },
    });
    const { access } = signup.json<AuthResponseBody>();

    const bind = await app.inject({
      method: 'POST',
      url: '/auth/bind',
      headers: { ...APP_HEADERS, authorization: `Bearer ${access}` },
      payload: { provider: 'google', id_token: `google-${randomUUID()}` },
    });
    expect(bind.statusCode).toBe(200);

    const retry = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers,
      payload: { device },
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json<ErrorResponseBody>().error.code).toBe('SIGNUP_USE_OAUTH');
    expect(retry.json<Record<string, unknown>>()['access']).toBeUndefined();
  });

  it('still D01-blocks a repeat device whose owner is suspended', async () => {
    const device = randomDevice();
    const headers = registrationHeaders();
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers,
      payload: { device },
    });
    const { user } = signup.json<AuthResponseBody>();
    await db.updateTable('users').set({ status: 'suspended' }).where('id', '=', user.id).execute();

    const retry = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers,
      payload: { device },
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json<ErrorResponseBody>().error.code).toBe('SIGNUP_BLOCKED');

    const flags = await db
      .selectFrom('fraud_flags')
      .selectAll()
      .where('user_id', '=', user.id)
      .where('rule_code', '=', 'D01')
      .execute();
    expect(flags).toHaveLength(1);
  });

  it('rate-limits guest recovery per fingerprint', async () => {
    const device = randomDevice();
    const installationId = randomUUID();
    const headers = registrationHeaders(installationId);
    const fingerprint = fingerprintOf(installationId);
    await rateLimitRedis.del(`auth-guest-recover:ratelimit:${fingerprint}`);
    await rateLimitRedis.del('auth-guest:ratelimit:127.0.0.1');

    await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers,
      payload: { device },
    });

    let lastStatus = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/guest',
        headers,
        payload: { device },
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
    await rateLimitRedis.del(`auth-guest-recover:ratelimit:${fingerprint}`);
    await rateLimitRedis.del('auth-guest:ratelimit:127.0.0.1');
  });

  it('refresh rotates tokens and revokes the whole chain on reuse', async () => {
    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers: registrationHeaders(),
      payload: { device: randomDevice() },
    });
    const { refresh: refresh1 } = signupRes.json<AuthResponseBody>();

    const rotateRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: APP_HEADERS,
      payload: { refresh: refresh1 },
    });
    expect(rotateRes.statusCode).toBe(200);
    const { refresh: refresh2 } = rotateRes.json<TokenPairBody>();
    expect(refresh2).not.toBe(refresh1);

    const reuseRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: APP_HEADERS,
      payload: { refresh: refresh1 },
    });
    expect(reuseRes.statusCode).toBe(401);
    expect(reuseRes.json<ErrorResponseBody>().error.code).toBe('REFRESH_TOKEN_REUSED');

    const rotateAgainRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: APP_HEADERS,
      payload: { refresh: refresh2 },
    });
    expect(rotateAgainRes.statusCode).toBe(401);
  });

  it('binds Google to the same guest account with one login credit and rejects a taken identity', async () => {
    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers: registrationHeaders(),
      payload: { device: randomDevice() },
    });
    const { access } = signupRes.json<AuthResponseBody>();
    const idToken = `google-${randomUUID()}:user@example.com`;

    const bindRes = await app.inject({
      method: 'POST',
      url: '/auth/bind',
      headers: { ...APP_HEADERS, authorization: `Bearer ${access}` },
      payload: { provider: 'google', id_token: idToken },
    });
    expect(bindRes.statusCode).toBe(200);
    const bindBody = bindRes.json<AuthResponseBody>();
    expect(bindBody.user.auth_provider).toBe('google');

    const walletRes = await app.inject({
      method: 'GET',
      url: '/wallet',
      headers: { ...APP_HEADERS, authorization: `Bearer ${bindBody.access}` },
    });
    expect(walletRes.json<WalletResponseBody>().available_coin).toBe('12000');

    const bindCredits = await db
      .selectFrom('coin_ledger')
      .select('id')
      .where('user_id', '=', bindBody.user.id)
      .where('entry_type', '=', 'LOGIN_BIND_CREDIT')
      .execute();
    expect(bindCredits).toHaveLength(1);

    const secondSignup = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers: registrationHeaders(),
      payload: { device: randomDevice() },
    });
    const secondAccess = secondSignup.json<AuthResponseBody>().access;

    const conflictRes = await app.inject({
      method: 'POST',
      url: '/auth/bind',
      headers: { ...APP_HEADERS, authorization: `Bearer ${secondAccess}` },
      payload: { provider: 'google', id_token: idToken },
    });
    expect(conflictRes.statusCode).toBe(409);
    expect(conflictRes.json<ErrorResponseBody>().error.code).toBe('IDENTITY_TAKEN');
  });

  it('awards configurable welcome and Google login credits once on Google authentication', async () => {
    const idToken = `google-${randomUUID()}:new-google@example.com`;
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/google',
      headers: registrationHeaders(),
      payload: { id_token: idToken, device: randomDevice() },
    });
    expect(signup.statusCode).toBe(200);
    const account = signup.json<AuthResponseBody>();

    const firstWallet = await db
      .selectFrom('wallets')
      .select('available_coin')
      .where('user_id', '=', account.user.id)
      .executeTakeFirstOrThrow();
    expect(firstWallet.available_coin).toBe('12000');

    const login = await app.inject({
      method: 'POST',
      url: '/auth/google',
      headers: registrationHeaders(),
      payload: { id_token: idToken, device: randomDevice() },
    });
    expect(login.statusCode).toBe(200);

    const credits = await db
      .selectFrom('coin_ledger')
      .select(['entry_type', 'amount'])
      .where('user_id', '=', account.user.id)
      .where('entry_type', 'in', ['WELCOME_CREDIT', 'LOGIN_BIND_CREDIT'])
      .execute();
    expect(credits).toHaveLength(2);
    expect(credits).toContainEqual({ entry_type: 'WELCOME_CREDIT', amount: '10000' });
    expect(credits).toContainEqual({ entry_type: 'LOGIN_BIND_CREDIT', amount: '2000' });
  });

  it('registers and logs in a password account with one welcome credit', async () => {
    const username = `user_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const password = 'correct horse battery staple';
    const register = await app.inject({
      method: 'POST',
      url: '/auth/password/register',
      headers: registrationHeaders(),
      payload: {
        username,
        email: `${username}@example.com`,
        password,
        device: randomDevice(),
      },
    });
    expect(register.statusCode).toBe(201);
    const registered = register.json<AuthResponseBody>();
    expect(registered.user.auth_provider).toBe('password');

    const login = await app.inject({
      method: 'POST',
      url: '/auth/password/login',
      headers: { ...APP_HEADERS, 'x-device-id': 'password-login-device' },
      payload: { username: username.toUpperCase(), password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json<AuthResponseBody>().user.id).toBe(registered.user.id);

    const wallet = await db
      .selectFrom('wallets')
      .select('available_coin')
      .where('user_id', '=', registered.user.id)
      .executeTakeFirstOrThrow();
    expect(wallet.available_coin).toBe('10000');
    const welcome = await db
      .selectFrom('coin_ledger')
      .select('id')
      .where('user_id', '=', registered.user.id)
      .where('entry_type', '=', 'WELCOME_CREDIT')
      .execute();
    expect(welcome).toHaveLength(1);
  });

  it('returns generic password failures and records the failed login', async () => {
    const username = `missing_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const response = await app.inject({
      method: 'POST',
      url: '/auth/password/login',
      headers: APP_HEADERS,
      payload: { username, password: 'this password is definitely wrong' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorResponseBody>().error.code).toBe('INVALID_CREDENTIALS');
    expect(response.json<ErrorResponseBody>().error.message).toBe('Invalid username or password');

    const event = await db
      .selectFrom('auth_events')
      .select(['outcome', 'failure_code'])
      .where('provider', '=', 'password')
      .where('event_type', '=', 'login')
      .where('failure_code', '=', 'INVALID_CREDENTIALS')
      .executeTakeFirst();
    expect(event?.outcome).toBe('failure');
  });

  it('verifies email, sends a reset token, resets password, and revokes old sessions', async () => {
    const username = `recover_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const email = `${username}@example.com`;
    const verificationTokens: string[] = [];
    const resetTokens: string[] = [];
    const recoveryApp = await buildApp({
      providers: { google: fakeIdentityProvider(), facebook: fakeIdentityProvider() },
      authEmailSender: {
        sendVerification(_to, token) {
          verificationTokens.push(token);
          return Promise.resolve();
        },
        sendPasswordReset(_to, token) {
          resetTokens.push(token);
          return Promise.resolve();
        },
      },
    });
    try {
      const register = await recoveryApp.inject({
        method: 'POST',
        url: '/auth/password/register',
        headers: registrationHeaders(),
        payload: {
          username,
          email,
          password: 'initial secure password',
          device: randomDevice(),
        },
      });
      expect(register.statusCode).toBe(201);
      const originalAccess = register.json<AuthResponseBody>().access;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(verificationTokens).toHaveLength(1);

      const verify = await recoveryApp.inject({
        method: 'POST',
        url: '/auth/password/verify-email',
        headers: APP_HEADERS,
        payload: { token: verificationTokens[0] },
      });
      expect(verify.statusCode).toBe(200);

      const forgot = await recoveryApp.inject({
        method: 'POST',
        url: '/auth/password/forgot',
        headers: APP_HEADERS,
        payload: { email },
      });
      expect(forgot.statusCode).toBe(200);
      expect(resetTokens).toHaveLength(1);

      const reset = await recoveryApp.inject({
        method: 'POST',
        url: '/auth/password/reset',
        headers: APP_HEADERS,
        payload: { token: resetTokens[0], new_password: 'replacement secure password' },
      });
      expect(reset.statusCode).toBe(200);

      const oldSession = await recoveryApp.inject({
        method: 'GET',
        url: '/wallet',
        headers: { ...APP_HEADERS, authorization: `Bearer ${originalAccess}` },
      });
      expect(oldSession.statusCode).toBe(401);

      const login = await recoveryApp.inject({
        method: 'POST',
        url: '/auth/password/login',
        headers: APP_HEADERS,
        payload: { username, password: 'replacement secure password' },
      });
      expect(login.statusCode).toBe(200);
    } finally {
      await recoveryApp.close();
    }
  });

  it('lists and revokes sessions, immediately invalidating the access token', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/guest',
      headers: registrationHeaders(),
      payload: { device: randomDevice() },
    });
    const auth = signup.json<AuthResponseBody>();
    const sessions = await app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: { ...APP_HEADERS, authorization: `Bearer ${auth.access}` },
    });
    expect(sessions.statusCode).toBe(200);
    const items = sessions.json<{ items: { id: string; current: boolean }[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.current).toBe(true);

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { ...APP_HEADERS, authorization: `Bearer ${auth.access}` },
    });
    expect(logout.statusCode).toBe(204);
    const wallet = await app.inject({
      method: 'GET',
      url: '/wallet',
      headers: { ...APP_HEADERS, authorization: `Bearer ${auth.access}` },
    });
    expect(wallet.statusCode).toBe(401);
    expect(wallet.json<ErrorResponseBody>().error.code).toBe('SESSION_REVOKED');
  });

  it('rate-limits guest signup attempts per IP', async () => {
    await rateLimitRedis.del('auth-guest:ratelimit:127.0.0.1');
    let lastStatus = 0;
    for (let i = 0; i < 21; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/guest',
        headers: registrationHeaders(),
        payload: { device: randomDevice() },
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
    await rateLimitRedis.del('auth-guest:ratelimit:127.0.0.1');
  });

  it('oauth login awards a missing welcome bonus once and never re-credits it', async () => {
    const idToken = `facebook-${randomUUID()}`;
    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/facebook',
      headers: registrationHeaders(),
      payload: { id_token: idToken, device: randomDevice() },
    });
    expect(signupRes.statusCode).toBe(200);
    const signupBody = signupRes.json<AuthResponseBody>();
    expect(signupBody.user.auth_provider).toBe('facebook');

    // Simulate an account created by the old Play Integrity path, where failed verification left
    // both the wallet and welcome ledger empty.
    await db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('coin_ledger')
        .where('user_id', '=', signupBody.user.id)
        .where('entry_type', '=', 'WELCOME_CREDIT')
        .execute();
      await trx
        .updateTable('wallets')
        .set({ available_coin: 0, lifetime_earned: 0 })
        .where('user_id', '=', signupBody.user.id)
        .execute();
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/facebook',
      headers: registrationHeaders(),
      payload: { id_token: idToken, device: randomDevice() },
    });
    expect(loginRes.statusCode).toBe(200);
    const loginBody = loginRes.json<AuthResponseBody>();
    expect(loginBody.user.id).toBe(signupBody.user.id);

    const walletRes = await app.inject({
      method: 'GET',
      url: '/wallet',
      headers: { ...APP_HEADERS, authorization: `Bearer ${loginBody.access}` },
    });
    expect(walletRes.json<WalletResponseBody>().available_coin).toBe('10000');

    const secondLoginRes = await app.inject({
      method: 'POST',
      url: '/auth/facebook',
      headers: registrationHeaders(),
      payload: { id_token: idToken, device: randomDevice() },
    });
    expect(secondLoginRes.statusCode).toBe(200);

    const welcomeEntries = await db
      .selectFrom('coin_ledger')
      .select('amount')
      .where('user_id', '=', signupBody.user.id)
      .where('entry_type', '=', 'WELCOME_CREDIT')
      .execute();
    expect(welcomeEntries).toHaveLength(1);
    expect(welcomeEntries[0]?.amount).toBe('10000');
  });
});
