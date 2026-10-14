import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JWT } from '@fastify/jwt';
import { uuidv7 } from 'uuidv7';
import { sql } from 'kysely';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { displayName } from '../../src/lib/display-name.js';
import { getOfferwallOffers } from '../../src/modules/earning/offerwall.service.js';

const APP_HEADERS = {
  'x-app-version': '1.0.0',
  'x-device-id': 'test-client',
  'accept-language': 'en',
};

// Player_ + the last six hex digits of the uuid, with the dashes stripped.
const DISPLAY_NAME_RE = /^Player_[0-9a-f]{6}$/;

interface MeBody {
  id: string;
  username: string;
  avatar_url: string | null;
  auth_provider: string;
  trust_level: number;
  region_id: string;
  referral_code: string | null;
  wallet: { available_coin: string; pending_coin: string };
}

interface RecentWinsBody {
  wins: { username: string; prize_label: string; prize_value: string; created_at: string }[];
}

interface OfferwallBody {
  enabled: boolean;
  offers: {
    id: string;
    provider: string;
    name: string;
    description: string;
    icon_url: string | null;
    badge_text: string | null;
    placement: string | null;
  }[];
  networks: {
    id: string;
    name: string;
    icon_url: string | null;
    placement: string | null;
    deeplink_url: null;
  }[];
}

interface LedgerBody {
  items: {
    id: string;
    entry_type: string;
    entry_label: string;
    offerwall: null | {
      provider: string;
      provider_label: string;
      transaction_id: string | null;
      status: 'pending' | 'available' | 'reversed';
      available_at: string | null;
    };
  }[];
  next_cursor: string | null;
}

interface CatalogBody {
  categories: unknown[];
  items: { sku: string }[];
}

async function createTestUser(): Promise<string> {
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
    })
    .execute();
  await db.insertInto('wallets').values({ user_id: userId, available_coin: 500 }).execute();
  return userId;
}

async function createSpinConfig(): Promise<string> {
  const id = uuidv7();
  const prizes = [{ slot: 1, type: 'coin', value: 10, weight: 100, tier: 'low', label: '10 coin' }];
  await sql`
    INSERT INTO spin_config (id, name, ticket_coin, daily_cap, pity_threshold, prizes)
    VALUES (${id}, ${`Surface test ${randomUUID()}`}, 100, 20, 50, ${JSON.stringify(prizes)}::jsonb)
  `.execute(db);
  return id;
}

describe('app surface endpoints', () => {
  let app: FastifyInstance;
  let accessJwt: JWT;

  beforeAll(async () => {
    app = await buildApp();
    accessJwt = (app.jwt as unknown as { access: JWT }).access;
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

  it('returns the full profile shape from GET /me', async () => {
    const userId = await createTestUser();
    const res = await app.inject({ method: 'GET', url: '/me', headers: auth(userId) });

    expect(res.statusCode).toBe(200);
    const body = res.json<MeBody>();
    expect(body.id).toBe(userId);
    expect(body.username).toMatch(DISPLAY_NAME_RE);
    expect(body.avatar_url).toBeNull();
    expect(body.auth_provider).toBe('guest');
    expect(body.trust_level).toBe(0);
    expect(body.region_id).toBe('VN');
    expect(body.wallet.available_coin).toBe('500');
    expect(body.wallet.pending_coin).toBe('0');
  });

  it('rejects GET /me without a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/me', headers: APP_HEADERS });
    expect(res.statusCode).toBe(401);
  });

  it('uses one anonymized name for a user across /me and /spin/recent-wins', async () => {
    const userId = await createTestUser();
    const configId = await createSpinConfig();
    await db
      .insertInto('spin_history')
      .values({
        id: uuidv7(),
        user_id: userId,
        spin_config_id: configId,
        server_seed_hash: randomUUID().replace(/-/g, ''),
        roll: '0.5',
        prize_slot: 1,
        prize_type: 'coin',
        prize_value: '10',
      })
      .execute();

    const me = await app.inject({ method: 'GET', url: '/me', headers: auth(userId) });
    expect(me.json<MeBody>().username).toBe(displayName(userId));

    const wins = await app.inject({ method: 'GET', url: '/spin/recent-wins' });
    expect(wins.statusCode).toBe(200);
    const body = wins.json<RecentWinsBody>();
    // The two endpoints used to slice a different number of characters off the uuid, so the same
    // person showed up under two names. Every row must now match the shared helper's format.
    for (const win of body.wins) {
      expect(win.username).toMatch(DISPLAY_NAME_RE);
    }
  });

  it('keeps /spin/recent-wins public, anonymous and capped at 10', async () => {
    const configId = await createSpinConfig();
    for (let index = 0; index < 12; index += 1) {
      const userId = await createTestUser();
      await db
        .insertInto('spin_history')
        .values({
          id: uuidv7(),
          user_id: userId,
          spin_config_id: configId,
          server_seed_hash: randomUUID().replace(/-/g, ''),
          roll: '0.5',
          prize_slot: 1,
          prize_type: 'coin',
          prize_value: '10',
        })
        .execute();
    }

    const res = await app.inject({ method: 'GET', url: '/spin/recent-wins' });
    expect(res.statusCode).toBe(200);
    const body = res.json<RecentWinsBody>();
    expect(body.wins.length).toBeLessThanOrEqual(10);
    expect(body.wins.length).toBeGreaterThan(0);
    for (const win of body.wins) {
      expect(Object.keys(win).sort()).toEqual([
        'created_at',
        'prize_label',
        'prize_value',
        'username',
      ]);
    }
  });

  it('offers PubScale and no longer offers AdGate', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/offerwall/offers',
      headers: APP_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<OfferwallBody>();
    expect(body.enabled).toBe(true);
    expect(body.offers.map((offer) => offer.id)).toEqual(['offer1', 'offer2']);
    expect(body.offers.map((offer) => offer.provider)).toEqual(['tapjoy', 'pubscale']);
    for (const offer of body.offers) expect(offer).toHaveProperty('reward_text', null);
    const ids = body.networks.map((network) => network.id);
    expect(ids).toContain('pubscale');
    // AdGate has no credentials and no network_config row — listing it rendered a dead tile.
    expect(ids).not.toContain('adgate');
    for (const network of body.networks) {
      // Offerwalls open through each network's SDK, so `placement` is the entry point and there is
      // no URL to navigate to — deeplink_url is retained as a null placeholder for one release.
      expect(network.deeplink_url).toBeNull();
      // Display metadata now comes from network_config; nothing real is seeded yet, and a fabricated
      // icon URL renders as a broken image, so null is the honest answer.
      expect(network.icon_url).toBeNull();
      expect(network).toHaveProperty('placement');
    }
    // Seeded by migration 39 — proves the display metadata is read from network_config, not from a
    // hardcoded map in the service.
    expect(body.networks.find((network) => network.id === 'pubscale')?.name).toBe('PubScale');
  });

  it('returns an empty network list when a region has the offerwall off', async () => {
    // Exercised at the service level: the route resolves the region from the caller IP, so it
    // cannot be pointed at a purpose-built region row.
    const regionId = `T_${randomUUID().slice(0, 8)}`;
    await db
      .insertInto('region_config')
      .values({ region_id: regionId, countries: [], features: { offerwall: { enabled: false } } })
      .execute();

    await expect(getOfferwallOffers(regionId)).resolves.toEqual({
      enabled: false,
      offers: [],
      networks: [],
    });
  });

  it('serves /redemptions/catalog as an alias of /catalog', async () => {
    const [primary, alias] = await Promise.all([
      app.inject({ method: 'GET', url: '/catalog', headers: APP_HEADERS }),
      app.inject({ method: 'GET', url: '/redemptions/catalog', headers: APP_HEADERS }),
    ]);

    expect(primary.statusCode).toBe(200);
    expect(alias.statusCode).toBe(200);
    const stableCatalog = (body: CatalogBody): CatalogBody => ({
      categories: body.categories,
      // catalog.test.ts mutates seagm-test-* rows in parallel with this suite. The migration-seeded
      // catalog is stable and is sufficient to prove both routes expose the same contract.
      items: body.items.filter((item) => !item.sku.startsWith('seagm-test-')),
    });
    expect(stableCatalog(alias.json<CatalogBody>())).toEqual(
      stableCatalog(primary.json<CatalogBody>()),
    );
  });

  it('serves /referral as an alias of /referral/stats', async () => {
    const userId = await createTestUser();
    const primary = await app.inject({
      method: 'GET',
      url: '/referral/stats',
      headers: auth(userId),
    });
    const alias = await app.inject({ method: 'GET', url: '/referral', headers: auth(userId) });

    expect(primary.statusCode).toBe(200);
    expect(alias.json()).toEqual(primary.json());
  });

  it('labels every ledger entry it returns', async () => {
    const userId = await createTestUser();
    const rows: { entry_type: 'WELCOME_CREDIT' | 'CHECKIN_CREDIT' | 'SPIN_TICKET_DEBIT' }[] = [
      { entry_type: 'WELCOME_CREDIT' },
      { entry_type: 'CHECKIN_CREDIT' },
      { entry_type: 'SPIN_TICKET_DEBIT' },
    ];
    for (const row of rows) {
      await db
        .insertInto('coin_ledger')
        .values({
          id: uuidv7(),
          user_id: userId,
          entry_type: row.entry_type,
          amount: 10,
          bucket: 'available',
          balance_after: 10,
          idempotency_key: `surface:${userId}:${row.entry_type}`,
        })
        .execute();
    }

    const res = await app.inject({
      method: 'GET',
      url: '/wallet/ledger',
      headers: auth(userId),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<LedgerBody>();
    expect(body.items).toHaveLength(3);

    const labels = new Map(body.items.map((item) => [item.entry_type, item.entry_label]));
    expect(labels.get('WELCOME_CREDIT')).toBe('Welcome bonus');
    expect(labels.get('CHECKIN_CREDIT')).toBe('Daily check-in');
    expect(labels.get('SPIN_TICKET_DEBIT')).toBe('Spin ticket');
    for (const item of body.items) {
      // The client no longer keeps its own copy of this map, so a missing label is a broken row.
      expect(item.entry_label).not.toBe('');
      expect(item.entry_type).toBeTruthy();
    }
  });

  it('attributes Tapjoy and PubScale offer gains and supports provider history filters', async () => {
    const userId = await createTestUser();
    const tapjoyEventId = uuidv7();
    const pubscaleEventId = uuidv7();
    const tapjoyTransactionId = `tapjoy-${randomUUID()}`;
    const pubscaleTransactionId = `pubscale-${randomUUID()}`;
    const tapjoyAvailableAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    await db
      .insertInto('earning_events')
      .values([
        {
          id: tapjoyEventId,
          user_id: userId,
          source: 'tapjoy',
          network_tx_id: tapjoyTransactionId,
          payout_usd: '1.0000',
          coin_awarded: 3000,
          share_applied: '0.3000',
          status: 'credited',
          raw_payload: {},
        },
        {
          id: pubscaleEventId,
          user_id: userId,
          source: 'pubscale',
          network_tx_id: pubscaleTransactionId,
          payout_usd: '2.0000',
          coin_awarded: 6000,
          share_applied: '0.3000',
          status: 'credited',
          raw_payload: {},
        },
      ])
      .execute();
    await db
      .insertInto('coin_ledger')
      .values([
        {
          id: uuidv7(),
          user_id: userId,
          entry_type: 'OFFERWALL_CREDIT',
          amount: 3000,
          bucket: 'pending',
          ref_type: 'earning_event',
          ref_id: tapjoyEventId,
          balance_after: 3000,
          hold_until: tapjoyAvailableAt,
        },
        {
          id: uuidv7(),
          user_id: userId,
          entry_type: 'OFFERWALL_CREDIT',
          amount: 6000,
          bucket: 'available',
          ref_type: 'earning_event',
          ref_id: pubscaleEventId,
          balance_after: 6500,
        },
      ])
      .execute();

    const combined = await app.inject({
      method: 'GET',
      url: '/wallet/ledger',
      headers: auth(userId),
    });
    expect(combined.statusCode).toBe(200);
    const offerRows = combined.json<LedgerBody>().items.filter((item) => item.offerwall !== null);
    const tapjoy = offerRows.find((item) => item.offerwall?.provider === 'tapjoy');
    const pubscale = offerRows.find((item) => item.offerwall?.provider === 'pubscale');
    expect(tapjoy?.offerwall).toMatchObject({
      provider_label: 'Tapjoy',
      transaction_id: tapjoyTransactionId,
      status: 'pending',
    });
    expect(new Date(tapjoy?.offerwall?.available_at ?? 0).getTime()).toBe(
      tapjoyAvailableAt.getTime(),
    );
    expect(pubscale?.offerwall).toMatchObject({
      provider_label: 'PubScale',
      transaction_id: pubscaleTransactionId,
      status: 'available',
      available_at: null,
    });

    for (const provider of ['tapjoy', 'pubscale'] as const) {
      const filtered = await app.inject({
        method: 'GET',
        url: `/wallet/ledger?provider=${provider}`,
        headers: auth(userId),
      });
      expect(filtered.statusCode).toBe(200);
      const filteredItems = filtered.json<LedgerBody>().items;
      expect(filteredItems).toHaveLength(1);
      expect(filteredItems[0]?.offerwall?.provider).toBe(provider);
    }
  });

  it('lists coin still on hold and when the next of it is released', async () => {
    const userId = await createTestUser();
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const later = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const entry = (
      amount: number,
      bucket: 'available' | 'pending',
      holdUntil: Date | null,
    ): {
      id: string;
      user_id: string;
      entry_type: 'REFERRAL_CREDIT';
      amount: number;
      bucket: 'available' | 'pending';
      balance_after: number;
      hold_until: Date | null;
    } => ({
      id: uuidv7(),
      user_id: userId,
      entry_type: 'REFERRAL_CREDIT',
      amount,
      bucket,
      balance_after: amount,
      hold_until: holdUntil,
    });
    const held = [entry(10, 'pending', later), entry(20, 'pending', soon)];
    await db
      .insertInto('coin_ledger')
      .values([
        ...held,
        // Frozen for review: pending, but with no real release date.
        entry(30, 'pending', new Date('2099-01-01T00:00:00Z')),
        // Already released: still bucket=pending, hold cleared.
        entry(40, 'pending', null),
        entry(50, 'available', null),
      ])
      .execute();

    const pending = await app.inject({
      method: 'GET',
      url: '/wallet/ledger?bucket=pending',
      headers: auth(userId),
    });
    expect(pending.statusCode).toBe(200);
    const items = pending.json<{ items: { amount: string; available_at: string | null }[] }>()
      .items;
    expect(items.map((item) => item.amount).sort()).toEqual(['10', '20', '30']);
    const releaseOf = (amount: string): string | null =>
      items.find((item) => item.amount === amount)?.available_at ?? null;
    expect(releaseOf('20')).toBe(soon.toISOString());
    expect(releaseOf('10')).toBe(later.toISOString());
    expect(releaseOf('30')).toBeNull();

    const wallet = await app.inject({ method: 'GET', url: '/wallet', headers: auth(userId) });
    expect(wallet.json<{ next_pending_release_at: string | null }>()).toMatchObject({
      available_coin: '500',
      next_pending_release_at: soon.toISOString(),
    });
  });

  it('exposes every app-surface route under the /v1 prefix too', async () => {
    const userId = await createTestUser();
    const cases: { url: string; headers: Record<string, string> }[] = [
      { url: '/v1/me', headers: auth(userId) },
      { url: '/v1/wallet/ledger', headers: auth(userId) },
      { url: '/v1/referral', headers: auth(userId) },
      { url: '/v1/redemptions/catalog', headers: APP_HEADERS },
      { url: '/v1/offerwall/offers', headers: APP_HEADERS },
      { url: '/v1/spin/recent-wins', headers: APP_HEADERS },
    ];

    for (const testCase of cases) {
      const res = await app.inject({
        method: 'GET',
        url: testCase.url,
        headers: testCase.headers,
      });
      expect(res.statusCode, testCase.url).toBe(200);
    }
  });
});
