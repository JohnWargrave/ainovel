// The app ships three separate AdMob rewarded units — check-in, earn-coin, and lucky-spin — but the
// backend has had no concept of which one an impression came from: one reward formula and one daily
// quota covered all three. That blocks per-position tuning (a spin ad funds a spin, not a coin
// payout) and makes revenue-by-position unanswerable.
//
// `placement` is nullable and left un-backfilled: rows predating this migration genuinely came from
// a client that could not say which unit served the ad, and NULL reads as "the legacy shared
// bucket" everywhere it is consumed. Inventing a value for them would be a guess recorded as fact.

exports.shorthands = undefined;

const PLACEMENT_DEFAULTS = {
  // cooldown_s is 0 for luckyspin only: spinning is the interaction, and a 30s gate between spins
  // would make the wheel feel broken. The other two keep the existing global cooldown.
  checkin: { daily_cap: 20, cooldown_s: 30, coin_multiplier: 1.0 },
  earncoin: { daily_cap: 20, cooldown_s: 30, coin_multiplier: 1.0 },
  luckyspin: { daily_cap: 20, cooldown_s: 0, coin_multiplier: 1.0 },
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE rewarded_ad_intents ADD COLUMN placement TEXT;
    ALTER TABLE earning_events      ADD COLUMN placement TEXT;

    CREATE INDEX rewarded_ad_intents_user_placement_created
      ON rewarded_ad_intents(user_id, placement, created_at DESC);
    CREATE INDEX earning_events_user_placement_created
      ON earning_events(user_id, placement, created_at DESC);
  `);

  // Seeded for every region that already has rewarded_ads configured. jsonb_set on the nested key
  // rather than replacing rewarded_ads wholesale — coin_cap and est_ecpm_usd are economy inputs that
  // are not represented here and must survive untouched.
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(
          features,
          '{rewarded_ads,placements}',
          '${JSON.stringify(PLACEMENT_DEFAULTS)}'::jsonb,
          true
        ),
        updated_at = now()
    WHERE features ? 'rewarded_ads';
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = features #- '{rewarded_ads,placements}',
        updated_at = now()
    WHERE features ? 'rewarded_ads';

    DROP INDEX IF EXISTS earning_events_user_placement_created;
    DROP INDEX IF EXISTS rewarded_ad_intents_user_placement_created;

    ALTER TABLE earning_events      DROP COLUMN IF EXISTS placement;
    ALTER TABLE rewarded_ad_intents DROP COLUMN IF EXISTS placement;
  `);
};
