import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { computeScore, recomputeScore } from '../../src/modules/fraud/score.service.js';
import { evaluateClawbackRate } from '../../src/modules/fraud/clawback-rule.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function createTestUser(overrides?: { status?: string }): Promise<string> {
  const userId = uuidv7();
  await db
    .insertInto('users')
    .values({
      id: userId,
      auth_provider: 'guest',
      auth_subject: `test-${randomUUID()}`,
      email: null,
      country_code: 'VN',
      region_id: 'VN',
      status: overrides?.status ?? 'active',
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId }).execute();
  return userId;
}

async function insertFlag(
  userId: string,
  ruleCode: string,
  severity: number,
  createdAt: Date,
): Promise<void> {
  await db
    .insertInto('fraud_flags')
    .values({
      id: uuidv7(),
      user_id: userId,
      rule_code: ruleCode,
      severity,
      evidence: JSON.stringify({}),
      created_at: createdAt,
    })
    .execute();
}

async function insertEarningEvent(
  userId: string,
  status: 'credited' | 'clawed_back',
): Promise<void> {
  await db
    .insertInto('earning_events')
    .values({
      id: uuidv7(),
      user_id: userId,
      device_id: null,
      source: 'tapjoy',
      network_tx_id: randomUUID(),
      payout_usd: '0.01',
      coin_awarded: 5,
      share_applied: null,
      geo_at_event: null,
      ip_at_event: null,
      status,
      raw_payload: JSON.stringify({}),
    })
    .execute();
}

// buildApp() isn't strictly needed to exercise the fraud module directly, but starting/stopping it
// keeps this suite consistent with the rest of the integration tests and confirms the app boots with
// the fraud module wired in.
describe('fraud engine v1', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('computeScore', () => {
    it('gives a flag created now its full weight (severity * 10)', () => {
      const now = new Date();
      expect(computeScore([{ severity: 5, created_at: now }], now)).toBe(50);
    });

    it('decays a 30-day-old flag to 0', () => {
      const now = new Date();
      const created = new Date(now.getTime() - 30 * DAY_MS);
      expect(computeScore([{ severity: 5, created_at: created }], now)).toBe(0);
    });

    it('applies linear partial decay at 15 days', () => {
      const now = new Date();
      const created = new Date(now.getTime() - 15 * DAY_MS);
      // severity 4 * 10 = 40, decayed by half at the 15-day midpoint => 20
      expect(computeScore([{ severity: 4, created_at: created }], now)).toBe(20);
    });

    it('clamps the total at 100', () => {
      const now = new Date();
      const flags = [
        { severity: 5, created_at: now },
        { severity: 5, created_at: now },
        { severity: 5, created_at: now },
      ];
      expect(computeScore(flags, now)).toBe(100);
    });
  });

  describe('recomputeScore', () => {
    it('caches the score on users.fraud_score and stays active/green under one weak flag', async () => {
      const userId = await createTestUser();
      await insertFlag(userId, 'N02', 2, new Date());

      const result = await recomputeScore(userId);
      expect(result.tier).toBe('green');

      const user = await db
        .selectFrom('users')
        .select(['fraud_score', 'status'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(user.fraud_score).toBe(result.score);
      expect(user.status).toBe('active');
    });

    it('auto-suspends and writes exactly one audit_log row once flags push the score red', async () => {
      const userId = await createTestUser();
      await insertFlag(userId, 'D03', 5, new Date()); // 50
      await insertFlag(userId, 'E01', 4, new Date()); // 40 => 90 total, red

      const result = await recomputeScore(userId);
      expect(result.tier).toBe('red');
      expect(result.score).toBe(90);

      const user = await db
        .selectFrom('users')
        .select(['fraud_score', 'status'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(user.status).toBe('suspended');
      expect(user.fraud_score).toBe(90);

      const auditRows = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('target_id', '=', userId)
        .where('action', '=', 'AUTO_FRAUD_SUSPEND')
        .execute();
      expect(auditRows).toHaveLength(1);

      // Idempotent: recomputing again for an already-suspended user must not re-suspend or
      // duplicate the audit trail.
      await recomputeScore(userId);
      const auditRowsAfter = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('target_id', '=', userId)
        .where('action', '=', 'AUTO_FRAUD_SUSPEND')
        .execute();
      expect(auditRowsAfter).toHaveLength(1);
    });

    it('never overrides an already-banned user back to suspended', async () => {
      const userId = await createTestUser({ status: 'banned' });
      await insertFlag(userId, 'D03', 5, new Date());
      await insertFlag(userId, 'E01', 4, new Date());

      await recomputeScore(userId);

      const user = await db
        .selectFrom('users')
        .select('status')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(user.status).toBe('banned');
    });
  });

  describe('evaluateClawbackRate (E01)', () => {
    it('flags E01 when the clawback rate exceeds 15% across at least 5 events', async () => {
      const userId = await createTestUser();
      await insertEarningEvent(userId, 'credited');
      await insertEarningEvent(userId, 'credited');
      await insertEarningEvent(userId, 'credited');
      await insertEarningEvent(userId, 'clawed_back');
      await insertEarningEvent(userId, 'clawed_back'); // 2/5 = 40%

      await evaluateClawbackRate(userId);

      const flags = await db
        .selectFrom('fraud_flags')
        .selectAll()
        .where('user_id', '=', userId)
        .where('rule_code', '=', 'E01')
        .execute();
      expect(flags).toHaveLength(1);
      expect(flags[0]?.severity).toBe(4);
    });

    it('does not flag below the 5-event floor even at a 100% clawback rate', async () => {
      const userId = await createTestUser();
      await insertEarningEvent(userId, 'clawed_back');
      await insertEarningEvent(userId, 'clawed_back');

      await evaluateClawbackRate(userId);

      const flags = await db
        .selectFrom('fraud_flags')
        .selectAll()
        .where('user_id', '=', userId)
        .where('rule_code', '=', 'E01')
        .execute();
      expect(flags).toHaveLength(0);
    });

    it('does not duplicate an E01 flag on repeated evaluation within the cooldown window', async () => {
      const userId = await createTestUser();
      await insertEarningEvent(userId, 'credited');
      await insertEarningEvent(userId, 'credited');
      await insertEarningEvent(userId, 'credited');
      await insertEarningEvent(userId, 'clawed_back');
      await insertEarningEvent(userId, 'clawed_back');

      await evaluateClawbackRate(userId);
      await evaluateClawbackRate(userId);

      const flags = await db
        .selectFrom('fraud_flags')
        .selectAll()
        .where('user_id', '=', userId)
        .where('rule_code', '=', 'E01')
        .execute();
      expect(flags).toHaveLength(1);
    });
  });
});
