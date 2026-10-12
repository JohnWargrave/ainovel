// 1700000000034 was corrected before release, but this follow-up also repairs databases that
// already applied the earlier version of that migration.
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE coin_ledger DROP CONSTRAINT IF EXISTS coin_ledger_pending_has_hold;`);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = () => undefined;
