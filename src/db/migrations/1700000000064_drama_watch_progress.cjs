// Server-verified drama watch progress, backing POST /drama/watch-heartbeat.
//
// Replaces watch_sessions for reward purposes. Two things differ and both matter:
//
// 1. UNIQUE (user_id, drama_id, episode_index). watch_sessions has only a plain index on
//    (user_id, episode_id), so its SELECT-FOR-UPDATE-then-INSERT races: two concurrent calls both
//    miss, both insert, and because the idempotency key was session-scoped they both credited. One
//    call per episode made that nearly unreachable; a heartbeat every few seconds does not.
//
// 2. drama_id is TEXT with no FK. The catalog lives in the app, not here — drama_series and
//    drama_episodes have never been populated in any environment (no seed, no admin CRUD), so
//    resolving an episode against them would 404 on every heartbeat.
//
// watch_sessions and the drama_* content tables are deliberately left in place; they may hold rows
// and nothing is gained by dropping them here.

exports.shorthands = undefined;

// completion_ratio and episode_reward_coin are new. episode_reward_daily_cap already exists in the
// seed from migration 14 and is reused rather than duplicated under a new name.
const DRAMA_DEFAULTS = { episode_reward_coin: 12, completion_ratio: 0.8 };

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE drama_watch_progress (
      id                UUID PRIMARY KEY,
      user_id           UUID NOT NULL REFERENCES users(id),
      drama_id          TEXT NOT NULL,
      episode_index     INTEGER NOT NULL,
      -- Pinned at the first heartbeat. A later body claiming a shorter duration must not be able to
      -- make the completion threshold cheaper.
      duration_s        INTEGER NOT NULL,
      -- Server-verified watch time, the only input the reward reads. Never the client's
      -- elapsed_seconds, which is a position and can be seeked.
      watch_time_s      INTEGER NOT NULL DEFAULT 0,
      last_position_s   INTEGER NOT NULL DEFAULT 0,
      last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- A timestamp rather than a boolean because the daily cap has to count *today's* rewards,
      -- which a boolean cannot answer.
      rewarded_at       TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, drama_id, episode_index)
    );

    CREATE INDEX drama_watch_progress_user_rewarded_idx
      ON drama_watch_progress (user_id, rewarded_at DESC)
      WHERE rewarded_at IS NOT NULL;
  `);

  // Merge into the existing drama object rather than replacing it — enabled, catalog_region,
  // interstitial_every and episode_reward_daily_cap are already configured and must survive.
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(
          features,
          '{drama}',
          COALESCE(features -> 'drama', '{}'::jsonb) || '${JSON.stringify(DRAMA_DEFAULTS)}'::jsonb,
          true
        ),
        updated_at = now();
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = features #- '{drama,episode_reward_coin}' #- '{drama,completion_ratio}',
        updated_at = now();

    DROP TABLE IF EXISTS drama_watch_progress;
  `);
};
