// A pending ledger row is historical: the original pending credit remains in the ledger after
// release and its hold_until is cleared. New pending credits are validated in ledger.service.ts.
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE coin_ledger DROP CONSTRAINT IF EXISTS coin_ledger_pending_has_hold;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE coin_ledger ADD CONSTRAINT coin_ledger_pending_has_hold CHECK (
    bucket <> 'pending' OR hold_until IS NOT NULL
  );`);
};
