// Mirrors 04-POSTBACK-SPEC.md §7 (AdMob SSV two-phase intent/callback flow). No table for this exists
// in 02-DATABASE-SCHEMA.md — closest analog is the (unbuilt, Phase 3) drama_ad_impressions shape.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE rewarded_ad_intents (
      id                UUID PRIMARY KEY,                    -- this IS the intent_id returned to the client
      user_id           UUID NOT NULL REFERENCES users(id),
      region_id         TEXT NOT NULL,                        -- snapshot at intent time only; coin formula
                                                                -- inputs are re-read fresh at SSV credit time
      status            TEXT NOT NULL DEFAULT 'pending',       -- pending|consumed|expired
      coin_awarded      BIGINT,
      earning_event_id  UUID REFERENCES earning_events(id),
      expires_at        TIMESTAMPTZ NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      consumed_at       TIMESTAMPTZ
    );
    CREATE INDEX rewarded_ad_intents_user_created ON rewarded_ad_intents(user_id, created_at DESC);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS rewarded_ad_intents;`);
};
