// offerwall_offers.reward_text: the earning headline on an offerwall tile ("Up to $15"). Free text the
// operator writes per offer; null hides the line.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE offerwall_offers ADD COLUMN reward_text TEXT;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE offerwall_offers DROP COLUMN IF EXISTS reward_text;`);
};
