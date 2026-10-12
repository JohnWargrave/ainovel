import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { argon2id, hash as hashPassword } from 'argon2';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

interface ErrorResponseBody {
  error: { code: string; message: string };
}

interface FraudFlagBody {
  id: string;
  user_id: string;
  rule_code: string;
  severity: number;
  status: string;
  user: { status: string; trust_level: number; fraud_score: number; region_id: string };
}

interface FraudFlagListBody {
  items: FraudFlagBody[];
  next_cursor: string | null;
}

interface FraudFlagReviewBody {
  flag: FraudFlagBody;
  fraud_score: number;
  tier: string;
}

interface AdminUserDetailBody {
  id: string;
  status: string;
  trust_level: number;
  fraud_score: number;
  wallet: { available_coin: string };
  open_flag_count: number;
  welcome_credit?: { granted: boolean; amount: string | null };
  password_credential?: { username: string } | null;
  active_sessions?: { id: string }[];
  auth_events?: { event_type: string }[];
}

interface AdminTestCreditBody {
  ledger_id: string;
  amount_coin: number;
  previous_balance: string;
  new_balance: string;
  deduped: boolean;
}

// Each test gets its own region: vitest runs files in parallel and the seeded VN/ROW rows are shared.
async function createRegion(): Promise<string> {
  const regionId = `F_${randomUUID().slice(0, 8)}`;
  await db
    .insertInto('region_config')
    .values({
      region_id: regionId,
      countries: [],
      features: {
        timezone: 'UTC',
        checkin: { enabled: true, rewards: [10, 15, 20] },
        tasks: {
          enabled: true,
          list: [
            {
              id: 'share_app',
              title: 'Share',
              description: 'Share it',
              reward_coin: 50,
              task_type: 'share_app',
            },
          ],
        },
      },
    })
    .execute();
  return regionId;
}

async function createUser(regionId: string): Promise<string> {
  const userId = uuidv7();
  await db
    .insertInto('users')
    .values({
      id: userId,
      auth_provider: 'guest',
      auth_subject: `fraud-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: regionId,
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId, available_coin: 0 }).execute();
  return userId;
}

async function createAdminUser(role: string): Promise<string> {
  const adminId = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id: adminId, email: `admin-${randomUUID()}@test.local`, role })
    .execute();
  return adminId;
}

async function seedFlag(userId: string, ruleCode: string, severity: number): Promise<string> {
  const flagId = uuidv7();
  await db
    .insertInto('fraud_flags')
    .values({
      id: flagId,
      user_id: userId,
      rule_code: ruleCode,
      severity,
      evidence: JSON.stringify({ seeded: true }),
      status: 'open',
    })
    .execute();
  return flagId;
}

describe('admin fraud queue and user actions', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;
  let reviewerId: string;
  let superadminId: string;
  let fulfillmentId: string;

  beforeAll(async () => {
    app = await buildApp();
    accessJwt = (app.jwt as unknown as { access: JWT }).access;
    reviewerId = await createAdminUser('reviewer');
    superadminId = await createAdminUser('superadmin');
    fulfillmentId = await createAdminUser('fulfillment');
  });

  afterAll(async () => {
    await app.close();
  });

  function auth(userId: string): Record<string, string> {
    return {
      ...APP_HEADERS,
      authorization: `Bearer ${accessJwt.sign({ sub: userId, trust_level: 0 })}`,
    };
  }

  function adminHeaders(adminUserId: string): Record<string, string> {
    return {
      'x-admin-api-key': ADMIN_API_KEY,
      'x-admin-user-id': adminUserId,
      'x-csrf-token': ADMIN_CSRF_TOKEN,
    };
  }

  it('lists open flags with the user context a reviewer needs, and filters', async () => {
    const regionId = await createRegion();
    const userId = await createUser(regionId);
    const other = await createUser(regionId);
    await seedFlag(userId, 'D02_DEVICE_SHARING', 4);
    await seedFlag(other, 'D05_VELOCITY', 2);

    const res = await app.inject({
      method: 'GET',
      url: `/admin/fraud/flags?status=open&user_id=${userId}`,
      headers: adminHeaders(reviewerId),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<FraudFlagListBody>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.rule_code).toBe('D02_DEVICE_SHARING');
    expect(body.items[0]?.user.region_id).toBe(regionId);
    expect(body.items[0]?.user.status).toBe('active');

    const byRule = await app.inject({
      method: 'GET',
      url: '/admin/fraud/flags?rule_code=D05_VELOCITY',
      headers: adminHeaders(reviewerId),
    });
    expect(
      byRule.json<FraudFlagListBody>().items.every((f) => f.rule_code === 'D05_VELOCITY'),
    ).toBe(true);
  });

  it('enforces role and credential checks on the queue', async () => {
    const wrongRole = await app.inject({
      method: 'GET',
      url: '/admin/fraud/flags',
      headers: adminHeaders(fulfillmentId),
    });
    expect(wrongRole.statusCode).toBe(403);

    const noKey = await app.inject({
      method: 'GET',
      url: '/admin/fraud/flags',
      headers: { 'x-admin-user-id': reviewerId },
    });
    expect(noKey.statusCode).toBe(401);
  });

  it('lowers the score when a flag is dismissed and records who did it', async () => {
    const userId = await createUser(await createRegion());
    const flagId = await seedFlag(userId, 'D02_DEVICE_SHARING', 4);
    await app.inject({
      method: 'POST',
      url: `/admin/fraud/flags/${flagId}/confirm`,
      headers: adminHeaders(reviewerId),
      payload: {},
    });

    // Confirming keeps the penalty: the signal was real.
    const confirmed = await db
      .selectFrom('users')
      .select('fraud_score')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(confirmed.fraud_score).toBe(40);

    const secondFlag = await seedFlag(userId, 'D05_VELOCITY', 3);
    const dismiss = await app.inject({
      method: 'POST',
      url: `/admin/fraud/flags/${secondFlag}/dismiss`,
      headers: adminHeaders(reviewerId),
      payload: { note: 'false positive' },
    });
    expect(dismiss.statusCode).toBe(200);
    const dismissBody = dismiss.json<FraudFlagReviewBody>();
    expect(dismissBody.flag.status).toBe('dismissed');
    // Only the confirmed severity-4 flag still counts.
    expect(dismissBody.fraud_score).toBe(40);
    expect(dismissBody.tier).toBe('yellow');

    const audit = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('target_id', '=', secondFlag)
      .where('action', '=', 'FRAUD_FLAG_DISMISSED')
      .executeTakeFirstOrThrow();
    expect(audit.admin_user_id).toBe(reviewerId);

    const again = await app.inject({
      method: 'POST',
      url: `/admin/fraud/flags/${secondFlag}/dismiss`,
      headers: adminHeaders(reviewerId),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<ErrorResponseBody>().error.code).toBe('FLAG_ALREADY_REVIEWED');
  });

  it('clears an auto-suspend score on dismissal but leaves the account suspended', async () => {
    const userId = await createUser(await createRegion());
    const heavy = await seedFlag(userId, 'D01_EMULATOR', 5);
    await seedFlag(userId, 'D02_DEVICE_SHARING', 3);

    // Any review triggers a recompute over open + confirmed flags: 5*10 + 3*10 = 80 → red → the
    // fraud engine soft-bans the account.
    const confirm = await app.inject({
      method: 'POST',
      url: `/admin/fraud/flags/${heavy}/confirm`,
      headers: adminHeaders(reviewerId),
      payload: {},
    });
    expect(confirm.statusCode).toBe(200);
    const suspended = await db
      .selectFrom('users')
      .select(['status', 'fraud_score'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(suspended.fraud_score).toBe(80);
    expect(suspended.status).toBe('suspended');

    // A confirmed flag is terminal — reviewing it again cannot be used to walk the score back.
    const reReview = await app.inject({
      method: 'POST',
      url: `/admin/fraud/flags/${heavy}/dismiss`,
      headers: adminHeaders(reviewerId),
      payload: {},
    });
    expect(reReview.statusCode).toBe(409);

    // Dismissing the remaining open flag is the only lever that moves the score.
    const openFlag = await db
      .selectFrom('fraud_flags')
      .select('id')
      .where('user_id', '=', userId)
      .where('status', '=', 'open')
      .executeTakeFirstOrThrow();
    const dismiss = await app.inject({
      method: 'POST',
      url: `/admin/fraud/flags/${openFlag.id}/dismiss`,
      headers: adminHeaders(reviewerId),
      payload: {},
    });
    expect(dismiss.statusCode).toBe(200);

    const after = await db
      .selectFrom('users')
      .select(['status', 'fraud_score'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    // Only the confirmed severity-5 flag still scores.
    expect(after.fraud_score).toBe(50);
    // Reinstatement is a separate, deliberate decision — the score dropping does not unlock the account.
    expect(after.status).toBe('suspended');
  });

  it('stops a suspended user from claiming a check-in', async () => {
    const regionId = await createRegion();
    const userId = await createUser(regionId);

    const suspend = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/suspend`,
      headers: adminHeaders(superadminId),
      payload: { reason: 'manual review' },
    });
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json<AdminUserDetailBody>().status).toBe('suspended');

    const claim = await app.inject({
      method: 'POST',
      url: '/checkin/claim',
      headers: auth(userId),
    });
    expect(claim.statusCode).toBe(403);
    expect(claim.json<ErrorResponseBody>().error.code).toBe('EARNING_SUSPENDED');

    const credits = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(credits).toHaveLength(0);
  });

  it('blocks a banned user from tasks and lets reinstate restore earning', async () => {
    const regionId = await createRegion();
    const userId = await createUser(regionId);

    await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/ban`,
      headers: adminHeaders(superadminId),
      payload: { reason: 'chargeback ring' },
    });

    const banned = await app.inject({
      method: 'POST',
      url: '/earning/tasks/claim',
      headers: auth(userId),
      payload: { task_id: 'share_app' },
    });
    expect(banned.statusCode).toBe(403);
    expect(banned.json<ErrorResponseBody>().error.code).toBe('EARNING_BLOCKED');

    const reinstate = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/reinstate`,
      headers: adminHeaders(superadminId),
      payload: { reason: 'appeal upheld' },
    });
    expect(reinstate.statusCode).toBe(200);
    expect(reinstate.json<AdminUserDetailBody>().status).toBe('active');

    const afterReinstate = await app.inject({
      method: 'POST',
      url: '/earning/tasks/claim',
      headers: auth(userId),
      payload: { task_id: 'share_app' },
    });
    expect(afterReinstate.statusCode).toBe(200);
  });

  it('writes one audit row per real status change and none for a repeat', async () => {
    const userId = await createUser(await createRegion());
    for (let i = 0; i < 2; i += 1) {
      await app.inject({
        method: 'POST',
        url: `/admin/users/${userId}/suspend`,
        headers: adminHeaders(superadminId),
        payload: { reason: 'double click' },
      });
    }

    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('target_id', '=', userId)
      .where('action', '=', 'ADMIN_USER_SUSPENDED')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({
      from: 'active',
      to: 'suspended',
      reason: 'double click',
    });
  });

  it('changes trust level within range and rejects anything outside it', async () => {
    const userId = await createUser(await createRegion());

    const ok = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/trust-level`,
      headers: adminHeaders(superadminId),
      payload: { trust_level: 2, reason: 'verified identity' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<AdminUserDetailBody>().trust_level).toBe(2);

    const audit = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('target_id', '=', userId)
      .where('action', '=', 'ADMIN_USER_TRUST_LEVEL_CHANGED')
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ from: 0, to: 2 });

    const tooHigh = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/trust-level`,
      headers: adminHeaders(superadminId),
      payload: { trust_level: 9, reason: 'nope' },
    });
    expect(tooHigh.statusCode).toBe(400);

    const noReason = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/suspend`,
      headers: adminHeaders(superadminId),
      payload: {},
    });
    expect(noReason.statusCode).toBe(400);
  });

  it('returns wallet and open-flag context on the user detail read', async () => {
    const userId = await createUser(await createRegion());
    await seedFlag(userId, 'D05_VELOCITY', 2);
    await db
      .updateTable('wallets')
      .set({ available_coin: '250' })
      .where('user_id', '=', userId)
      .execute();

    const res = await app.inject({
      method: 'GET',
      url: `/admin/users/${userId}`,
      headers: adminHeaders(reviewerId),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminUserDetailBody>();
    expect(body.wallet.available_coin).toBe('250');
    expect(body.open_flag_count).toBe(1);

    const missing = await app.inject({
      method: 'GET',
      url: `/admin/users/${uuidv7()}`,
      headers: adminHeaders(reviewerId),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('requires the CSRF token and superadmin role on every write', async () => {
    const userId = await createUser(await createRegion());

    const noCsrf = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/suspend`,
      headers: { 'x-admin-api-key': ADMIN_API_KEY, 'x-admin-user-id': superadminId },
      payload: { reason: 'no csrf' },
    });
    expect(noCsrf.statusCode).toBe(403);

    const reviewerWrite = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/ban`,
      headers: adminHeaders(reviewerId),
      payload: { reason: 'not my call' },
    });
    expect(reviewerWrite.statusCode).toBe(403);

    const stillActive = await db
      .selectFrom('users')
      .select('status')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(stillActive.status).toBe('active');
  });

  it('grants a bounded, idempotent and audited test credit to a user', async () => {
    const userId = await createUser(await createRegion());
    const payload = {
      amount_coin: 2_000,
      reason: 'Lucky Spin QA',
      idempotency_key: `spin-qa-${randomUUID()}`,
    };

    const first = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/test-credit`,
      headers: adminHeaders(superadminId),
      payload,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<AdminTestCreditBody>();
    expect(firstBody).toMatchObject({
      amount_coin: 2_000,
      previous_balance: '0',
      new_balance: '2000',
      deduped: false,
    });

    const replay = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/test-credit`,
      headers: adminHeaders(superadminId),
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<AdminTestCreditBody>()).toMatchObject({
      ledger_id: firstBody.ledger_id,
      previous_balance: '0',
      new_balance: '2000',
      deduped: true,
    });

    const ledger = await db
      .selectFrom('coin_ledger')
      .selectAll()
      .where('user_id', '=', userId)
      .where('entry_type', '=', 'ADMIN_ADJUSTMENT')
      .execute();
    expect(ledger).toHaveLength(1);

    const audit = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('target_id', '=', userId)
      .where('action', '=', 'ADMIN_TEST_CREDIT_GRANTED')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.admin_user_id).toBe(superadminId);
    expect(audit[0]?.detail).toMatchObject({ reason: 'Lucky Spin QA', amount_coin: 2_000 });
  });

  it('restricts test credit to superadmin and validates its amount', async () => {
    const userId = await createUser(await createRegion());
    const reviewer = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/test-credit`,
      headers: adminHeaders(reviewerId),
      payload: {
        amount_coin: 100,
        reason: 'Spin QA',
        idempotency_key: `spin-qa-${randomUUID()}`,
      },
    });
    expect(reviewer.statusCode).toBe(403);

    const excessive = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/test-credit`,
      headers: adminHeaders(superadminId),
      payload: {
        amount_coin: 100_001,
        reason: 'Spin QA',
        idempotency_key: `spin-qa-${randomUUID()}`,
      },
    });
    expect(excessive.statusCode).toBe(400);
  });

  it('uses individual password credentials and a revocable CMS cookie session', async () => {
    const password = 'secure cms password for test';
    const passwordHash = await hashPassword(password, {
      type: argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });
    const email = `cms-${randomUUID()}@test.local`;
    const adminId = uuidv7();
    await db
      .insertInto('admin_users')
      .values({ id: adminId, email, role: 'superadmin', password_hash: passwordHash })
      .execute();

    const rejected = await app.inject({
      method: 'POST',
      url: '/admin/session',
      payload: { email, password: 'wrong password for this admin' },
    });
    expect(rejected.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/admin/session',
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const session = login.json<{ csrf_token: string; admin_user: { id: string } }>();
    expect(session.admin_user.id).toBe(adminId);

    const current = await app.inject({
      method: 'GET',
      url: '/admin/session',
      headers: { cookie: String(cookie) },
    });
    expect(current.statusCode).toBe(200);

    const logout = await app.inject({
      method: 'DELETE',
      url: '/admin/session',
      headers: { cookie: String(cookie), 'x-csrf-token': session.csrf_token },
    });
    expect(logout.statusCode).toBe(204);

    const reused = await app.inject({
      method: 'GET',
      url: '/admin/session',
      headers: { cookie: String(cookie) },
    });
    expect(reused.statusCode).toBe(401);
  });

  it('shows account authentication data and safely manages coin, credentials, and sessions', async () => {
    const username = `cmsuser_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const register = await app.inject({
      method: 'POST',
      url: '/auth/password/register',
      headers: { ...APP_HEADERS, 'x-device-id': randomUUID() },
      payload: {
        username,
        email: `${username}@example.com`,
        password: 'secure account password',
        device: { gaid: randomUUID(), model: 'CMS Test', os: 'Android 15' },
      },
    });
    expect(register.statusCode).toBe(201);
    const userId = register.json<{ user: { id: string } }>().user.id;

    const detail = await app.inject({
      method: 'GET',
      url: `/admin/users/${userId}`,
      headers: adminHeaders(superadminId),
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json<AdminUserDetailBody>();
    expect(detailBody.welcome_credit).toEqual({
      granted: true,
      amount: '10000',
      granted_at: expect.any(String),
    });
    expect(detailBody.password_credential?.username).toBe(username);
    expect(detailBody.active_sessions).toHaveLength(1);
    expect(detailBody.auth_events?.some((event) => event.event_type === 'register')).toBe(true);

    const lastCredential = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/credentials/password/disable`,
      headers: adminHeaders(superadminId),
      payload: { reason: 'test last credential protection' },
    });
    expect(lastCredential.statusCode).toBe(409);
    expect(lastCredential.json<ErrorResponseBody>().error.code).toBe('LAST_LOGIN_METHOD');

    const adjustmentKey = `adjust-${randomUUID()}`;
    const credit = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/coin-adjustment`,
      headers: adminHeaders(superadminId),
      payload: { amount_coin: 500, reason: 'support correction', idempotency_key: adjustmentKey },
    });
    expect(credit.statusCode).toBe(200);
    expect(credit.json<AdminTestCreditBody>().new_balance).toBe('10500');
    const replay = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/coin-adjustment`,
      headers: adminHeaders(superadminId),
      payload: { amount_coin: 500, reason: 'support correction', idempotency_key: adjustmentKey },
    });
    expect(replay.json<AdminTestCreditBody>().deduped).toBe(true);
    const debit = await app.inject({
      method: 'POST',
      url: `/admin/users/${userId}/coin-adjustment`,
      headers: adminHeaders(superadminId),
      payload: {
        amount_coin: -200,
        reason: 'reverse support correction',
        idempotency_key: `adjust-${randomUUID()}`,
      },
    });
    expect(debit.statusCode).toBe(200);
    expect(debit.json<AdminTestCreditBody>().new_balance).toBe('10300');

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/admin/users/${userId}/sessions/${detailBody.active_sessions?.[0]?.id ?? ''}`,
      headers: adminHeaders(superadminId),
      payload: { reason: 'user requested logout' },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json<AdminUserDetailBody>().active_sessions).toHaveLength(0);
  });
});
