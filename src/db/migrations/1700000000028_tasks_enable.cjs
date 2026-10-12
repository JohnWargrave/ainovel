// Enable daily tasks feature for VN and ROW regions.
// We add the 'tasks' feature config with default enabled = true.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(
      features, 
      '{tasks}', 
      '{"enabled": true}'::jsonb, 
      true
    )
    WHERE region_id IN ('VN', 'ROW');
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = features - 'tasks'
    WHERE region_id IN ('VN', 'ROW');
  `);
};
