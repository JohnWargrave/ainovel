// Drama watch-to-earn is retired in favour of novel read-to-earn (1700000000066). The content tables
// were never populated, and drama_watch_progress only held per-episode progress that no code reads
// any more. Paid rewards are unaffected: they live in coin_ledger as DRAMA_WATCH_CREDIT rows, which
// stay (Postgres cannot drop enum values, and the history must remain auditable).

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS drama_watch_progress;
    DROP TABLE IF EXISTS watch_sessions;
    DROP TABLE IF EXISTS drama_ad_impressions;
    DROP TABLE IF EXISTS drama_episodes;
    DROP TABLE IF EXISTS drama_series;

    UPDATE region_config SET features = features - 'drama', updated_at = now() WHERE features ? 'drama';
  `);
};

exports.down = () => {
  // Deliberately irreversible: the dropped tables held no data worth restoring, and recreating empty
  // drama tables would not bring the removed feature back.
};
