import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { getOfferwallOffers } from '../../src/modules/earning/offerwall.service.js';

const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

interface ErrorBody {
  error: { code: string; message: string };
}

interface OfferBody {
  id: string;
  code: string;
  provider: string;
  name: string;
  status: string;
  region_ids: string[];
  sort_order: number;
  starts_at: string | null;
  ends_at: string | null;
}

interface ProviderBody {
  provider: string;
  placement: string | null;
  placement_source: string;
  hold_hours: number;
  high_value_threshold_usd: string;
  high_value_hold_hours: number;
  credit_immediately: boolean;
  secret_configured: boolean;
  shadow_mode: boolean;
  callback_url: string;
}

async function createAdmin(role: string): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id, email: `offerwall-${randomUUID()}@test.local`, role })
    .execute();
  return id;
}

function adminHeaders(id: string, csrf = true): Record<string, string> {
  return {
    'x-admin-api-key': ADMIN_API_KEY,
    'x-admin-user-id': id,
    ...(csrf ? { 'x-csrf-token': ADMIN_CSRF_TOKEN } : {}),
  };
}

describe('offerwall CMS management', () => {
  let app: FastifyInstance;
  let superadminId: string;
  let reviewerId: string;
  const createdOfferIds: string[] = [];
  const createdRegionIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    superadminId = await createAdmin('superadmin');
    reviewerId = await createAdmin('reviewer');
  });

  afterAll(async () => {
    if (createdOfferIds.length > 0) {
      await db.deleteFrom('offerwall_offers').where('id', 'in', createdOfferIds).execute();
    }
    if (createdRegionIds.length > 0) {
      await db.deleteFrom('region_config').where('region_id', 'in', createdRegionIds).execute();
    }
    await app.close();
  });

  it('seeds offer1 for Tapjoy and offer2 for PubScale in display order', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/offerwall/offers',
      headers: adminHeaders(superadminId),
    });
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: OfferBody[] }>().items;
    expect(items.slice(0, 2).map(({ code, provider }) => ({ code, provider }))).toEqual([
      { code: 'offer1', provider: 'tapjoy' },
      { code: 'offer2', provider: 'pubscale' },
    ]);
  });

  it('creates, updates, lists and archives a launch card with audit history', async () => {
    const code = `test-${randomUUID().slice(0, 8)}`;
    const created = await app.inject({
      method: 'POST',
      url: '/admin/offerwall/offers',
      headers: adminHeaders(superadminId),
      payload: {
        code,
        provider: 'tapjoy',
        name: 'QA Tapjoy card',
        description: 'Complete tasks',
        region_ids: ['VN'],
        sort_order: 30,
        status: 'draft',
      },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json<OfferBody>();
    createdOfferIds.push(createdBody.id);
    expect(createdBody).toMatchObject({ code, provider: 'tapjoy', status: 'draft' });

    const updated = await app.inject({
      method: 'PATCH',
      url: `/admin/offerwall/offers/${createdBody.id}`,
      headers: adminHeaders(superadminId),
      payload: { name: 'Featured Tapjoy', status: 'active', sort_order: 5 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<OfferBody>()).toMatchObject({
      name: 'Featured Tapjoy',
      status: 'active',
      sort_order: 5,
    });

    const filtered = await app.inject({
      method: 'GET',
      url: '/admin/offerwall/offers?provider=tapjoy&status=active',
      headers: adminHeaders(superadminId),
    });
    expect(
      filtered.json<{ items: OfferBody[] }>().items.some((item) => item.id === createdBody.id),
    ).toBe(true);

    const archived = await app.inject({
      method: 'DELETE',
      url: `/admin/offerwall/offers/${createdBody.id}`,
      headers: adminHeaders(superadminId),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<OfferBody>().status).toBe('archived');

    const audit = await db
      .selectFrom('audit_log')
      .select(['action', 'admin_user_id'])
      .where('target_id', '=', createdBody.id)
      .orderBy('created_at', 'asc')
      .execute();
    expect(audit.map((entry) => entry.action)).toEqual([
      'OFFERWALL_OFFER_CREATED',
      'OFFERWALL_OFFER_UPDATED',
      'OFFERWALL_OFFER_ARCHIVED',
    ]);
    expect(audit.every((entry) => entry.admin_user_id === superadminId)).toBe(true);
  });

  it('enforces superadmin access, CSRF, provider existence and valid schedules', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: '/admin/offerwall/offers',
      headers: adminHeaders(reviewerId),
    });
    expect(denied.statusCode).toBe(403);

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/admin/offerwall/offers',
      headers: adminHeaders(superadminId, false),
      payload: {
        code: `test-${randomUUID().slice(0, 8)}`,
        provider: 'tapjoy',
        name: 'No CSRF',
        region_ids: ['VN'],
      },
    });
    expect(missingCsrf.statusCode).toBe(403);

    const badProvider = await app.inject({
      method: 'POST',
      url: '/admin/offerwall/offers',
      headers: adminHeaders(superadminId),
      payload: {
        code: `test-${randomUUID().slice(0, 8)}`,
        provider: 'missing-provider',
        name: 'Bad provider',
        region_ids: ['VN'],
      },
    });
    expect(badProvider.statusCode).toBe(400);

    const invalidSchedule = await app.inject({
      method: 'POST',
      url: '/admin/offerwall/offers',
      headers: adminHeaders(superadminId),
      payload: {
        code: `test-${randomUUID().slice(0, 8)}`,
        provider: 'tapjoy',
        name: 'Bad schedule',
        region_ids: ['VN'],
        starts_at: '2026-09-02T00:00:00.000Z',
        ends_at: '2026-09-01T00:00:00.000Z',
      },
    });
    expect(invalidSchedule.statusCode).toBe(400);
    expect(invalidSchedule.json<ErrorBody>().error.code).toBe('INVALID_SCHEDULE');
  });

  it('returns provider settings without exposing secrets and audits safe setting changes', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: '/admin/offerwall/providers',
      headers: adminHeaders(superadminId),
    });
    expect(listed.statusCode).toBe(200);
    const providers = listed.json<{ items: ProviderBody[] }>().items;
    expect(providers.map((provider) => provider.provider).sort()).toEqual(['pubscale', 'tapjoy']);
    for (const provider of providers) {
      expect(provider).not.toHaveProperty('secret_key');
      expect(provider.secret_configured).toBe(false);
      expect(Number(provider.high_value_threshold_usd)).toBeGreaterThan(0);
      expect(provider.high_value_hold_hours).toBeGreaterThanOrEqual(provider.hold_hours);
      expect(typeof provider.credit_immediately).toBe('boolean');
      expect(provider.callback_url).toBe(`https://api.ainovel.com/postback/${provider.provider}`);
    }
    const tapjoyProvider = providers.find((provider) => provider.provider === 'tapjoy');
    if (!tapjoyProvider) throw new Error('Tapjoy provider missing');
    const nextCreditImmediately = !tapjoyProvider.credit_immediately;

    const tapjoyBefore = await db
      .selectFrom('network_config')
      .select(['display_name'])
      .where('network', '=', 'tapjoy')
      .executeTakeFirstOrThrow();
    const updated = await app.inject({
      method: 'PATCH',
      url: '/admin/offerwall/providers/tapjoy',
      headers: adminHeaders(superadminId),
      // Hold values are deliberately not sent: postback.test.ts changes them temporarily in parallel,
      // and echoing back a value read mid-change would make it permanent.
      payload: {
        display_name: tapjoyBefore.display_name,
        credit_immediately: nextCreditImmediately,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<ProviderBody>()).toMatchObject({
      provider: 'tapjoy',
      credit_immediately: nextCreditImmediately,
    });

    await db
      .updateTable('network_config')
      .set({ credit_immediately: tapjoyProvider.credit_immediately })
      .where('network', '=', 'tapjoy')
      .execute();

    const audit = await db
      .selectFrom('audit_log')
      .select('detail')
      .where('action', '=', 'OFFERWALL_PROVIDER_UPDATED')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.detail)).not.toContain('dev-placeholder-tapjoy-secret');

    const invalidHoldPolicy = await app.inject({
      method: 'PATCH',
      url: '/admin/offerwall/providers/tapjoy',
      headers: adminHeaders(superadminId),
      payload: { hold_hours: 100, high_value_hold_hours: 99 },
    });
    expect(invalidHoldPolicy.statusCode).toBe(400);
    expect(invalidHoldPolicy.json<ErrorBody>().error.code).toBe('INVALID_HOLD_POLICY');

    const unsupportedBefore = await db
      .selectFrom('network_config')
      .select('display_name')
      .where('network', '=', 'adgate')
      .executeTakeFirstOrThrow();
    const unsupported = await app.inject({
      method: 'PATCH',
      url: '/admin/offerwall/providers/adgate',
      headers: adminHeaders(superadminId),
      payload: { display_name: 'Must not change' },
    });
    expect(unsupported.statusCode).toBe(400);
    const unsupportedAfter = await db
      .selectFrom('network_config')
      .select('display_name')
      .where('network', '=', 'adgate')
      .executeTakeFirstOrThrow();
    expect(unsupportedAfter.display_name).toBe(unsupportedBefore.display_name);
  });

  it('updates only the offerwall settings for a region', async () => {
    const regionId = `OW_${randomUUID().slice(0, 8)}`;
    createdRegionIds.push(regionId);
    await db
      .insertInto('region_config')
      .values({
        region_id: regionId,
        countries: [],
        features: { timezone: 'UTC', checkin: { enabled: true } },
      })
      .execute();

    const updated = await app.inject({
      method: 'PATCH',
      url: `/admin/offerwall/settings/${regionId}`,
      headers: adminHeaders(superadminId),
      payload: {
        enabled: true,
        networks: ['tapjoy', 'pubscale'],
        shares: { '0': 0.3, '1': 0.35, '2': 0.4, '3': 0.5 },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      region_id: regionId,
      enabled: true,
      networks: ['tapjoy', 'pubscale'],
    });

    const stored = await db
      .selectFrom('region_config')
      .select('features')
      .where('region_id', '=', regionId)
      .executeTakeFirstOrThrow();
    expect(stored.features).toMatchObject({
      timezone: 'UTC',
      checkin: { enabled: true },
      offerwall: { enabled: true },
    });
  });

  it('filters public cards by status, schedule, region and provider activation', async () => {
    const regionId = `OW_${randomUUID().slice(0, 8)}`;
    createdRegionIds.push(regionId);
    await db
      .insertInto('region_config')
      .values({
        region_id: regionId,
        countries: [],
        features: {
          offerwall: {
            enabled: true,
            networks: ['tapjoy', 'pubscale'],
            shares: { '0': 0.3, '1': 0.35, '2': 0.4, '3': 0.5 },
          },
        },
      })
      .execute();

    const offers = [
      {
        code: `active-${randomUUID().slice(0, 8)}`,
        provider: 'tapjoy',
        name: 'First active',
        status: 'active',
        sort_order: 1,
        starts_at: null,
        ends_at: null,
      },
      {
        code: `future-${randomUUID().slice(0, 8)}`,
        provider: 'tapjoy',
        name: 'Future',
        status: 'active',
        sort_order: 2,
        starts_at: new Date(Date.now() + 86_400_000),
        ends_at: null,
      },
      {
        code: `paused-${randomUUID().slice(0, 8)}`,
        provider: 'pubscale',
        name: 'Paused',
        status: 'paused',
        sort_order: 3,
        starts_at: null,
        ends_at: null,
      },
    ];
    for (const offer of offers) {
      const id = uuidv7();
      createdOfferIds.push(id);
      await db
        .insertInto('offerwall_offers')
        .values({
          id,
          ...offer,
          description: '',
          region_ids: [regionId],
        })
        .execute();
    }

    const response = await getOfferwallOffers(regionId);
    expect(response.offers.map((offer) => offer.name)).toEqual(['First active']);
    expect(response.networks.map((network) => network.id)).toEqual(['tapjoy', 'pubscale']);
  });
});
