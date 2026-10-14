// How the one-time welcome bonus is paid:
// - instant: on account creation, guest included (the behaviour so far).
// - link_required: guests get nothing until they link Google/Facebook or add a password; the bonus
//   is paid by that bind. Accounts created through Google/Facebook/password are paid at once either
//   way.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE coin_reward_settings
      ADD COLUMN welcome_mode TEXT NOT NULL DEFAULT 'instant'
        CHECK (welcome_mode IN ('instant', 'link_required'));
  `);
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE coin_reward_settings DROP COLUMN IF EXISTS welcome_mode;');
};
