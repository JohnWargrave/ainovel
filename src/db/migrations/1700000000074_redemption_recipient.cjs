// Rewards paid to an account rather than delivered as a code. catalog_items.recipient_type says what
// the app must collect before redeeming ('paypal_email': the PayPal address the reward is sent to);
// redemptions.recipient_email keeps it for fulfillment, which sends the money by hand.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE catalog_items
      ADD COLUMN recipient_type TEXT NOT NULL DEFAULT 'none'
        CHECK (recipient_type IN ('none', 'paypal_email'));
    UPDATE catalog_items SET recipient_type = 'paypal_email' WHERE category = 'paypal';

    ALTER TABLE redemptions ADD COLUMN recipient_email TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE redemptions DROP COLUMN IF EXISTS recipient_email;
    ALTER TABLE catalog_items DROP COLUMN IF EXISTS recipient_type;
  `);
};
