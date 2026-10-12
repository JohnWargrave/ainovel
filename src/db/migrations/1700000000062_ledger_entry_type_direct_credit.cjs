// DIRECT_CREDIT backs POST /earning/coin, where the client supplies the amount. It gets its own
// entry type rather than reusing ADMIN_ADJUSTMENT so the two are separable in the ledger: an admin
// correction is a human decision with an audit_log row behind it, a direct credit is not. Anyone
// auditing minted coin needs to be able to tell them apart without joining anything.
//
// ALTER TYPE ... ADD VALUE cannot run in the transaction that later uses the value, so this
// migration runs outside one — same reasoning as 1700000000011.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.noTransaction();
  await pgm.db.query(`ALTER TYPE ledger_entry_type ADD VALUE IF NOT EXISTS 'DIRECT_CREDIT'`);
};

exports.down = () => {
  // Postgres has no DROP VALUE for enums; down is a deliberate no-op (documented limitation).
};
