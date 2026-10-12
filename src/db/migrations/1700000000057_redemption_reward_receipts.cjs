// Keep the reward label shown in history stable even when the live catalog item is edited later.
// claimed_at tracks the first successful owner access separately from fulfillment state.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE redemptions
      ADD COLUMN reward_snapshot JSONB,
      ADD COLUMN claimed_at TIMESTAMPTZ;

    UPDATE redemptions AS redemption
    SET reward_snapshot = jsonb_build_object(
      'sku', item.sku,
      'title', item.title,
      'category', item.category,
      'face_value', item.face_value,
      'image_url', item.image_url
    )
    FROM catalog_items AS item
    WHERE item.id = redemption.catalog_item_id;

    ALTER TABLE redemptions
      ALTER COLUMN reward_snapshot SET NOT NULL;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE redemptions
      DROP COLUMN IF EXISTS claimed_at,
      DROP COLUMN IF EXISTS reward_snapshot;
  `);
};
