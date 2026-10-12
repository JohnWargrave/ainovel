// CMS-managed launch cards for provider-owned offerwalls. These are not individual partner tasks:
// Tapjoy and PubScale continue to render and attribute those inside their Android SDKs.

exports.shorthands = undefined;

const TAPJOY_OFFER_ID = '00000000-0000-7000-8000-000000000043';
const PUBSCALE_OFFER_ID = '00000000-0000-7000-8000-000000000044';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE offerwall_offers (
      id          UUID PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      provider    TEXT NOT NULL REFERENCES network_config(network),
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon_url    TEXT,
      badge_text  TEXT,
      placement   TEXT,
      region_ids  TEXT[] NOT NULL DEFAULT '{}',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'paused', 'archived')),
      starts_at   TIMESTAMPTZ,
      ends_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
    );

    CREATE INDEX offerwall_offers_public_idx
      ON offerwall_offers (status, sort_order, code);
    CREATE INDEX offerwall_offers_regions_idx
      ON offerwall_offers USING GIN (region_ids);

    INSERT INTO offerwall_offers
      (id, code, provider, name, description, region_ids, sort_order, status)
    VALUES
      (
        '${TAPJOY_OFFER_ID}',
        'offer1',
        'tapjoy',
        'offer1',
        'Complete Tapjoy offers and earn coins',
        ARRAY['VN', 'ROW'],
        10,
        'active'
      ),
      (
        '${PUBSCALE_OFFER_ID}',
        'offer2',
        'pubscale',
        'offer2',
        'Discover PubScale offers and earn coins',
        ARRAY['VN', 'ROW'],
        20,
        'active'
      );
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS offerwall_offers;`);
};
