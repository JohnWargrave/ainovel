// The CMS reward monitors constrain by provider and time, then page newest-first. These indexes
// keep that operational read path bounded as callback and earning history grows.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS postback_logs_network_created_idx;
    CREATE INDEX postback_logs_network_created_idx
      ON postback_logs (network, created_at DESC, id DESC);
    CREATE INDEX earning_events_source_created_idx
      ON earning_events (source, created_at DESC, id DESC);
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS earning_events_source_created_idx;
    DROP INDEX IF EXISTS postback_logs_network_created_idx;
    CREATE INDEX postback_logs_network_created_idx
      ON postback_logs (network, created_at DESC);
  `);
};
