// users.public_id: the short numeric ID the profile screen shows ("ID 10284731") and support asks
// for. The UUID stays the key everywhere else; this is display-only and never accepted as input.
// Existing accounts are numbered in signup order.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE SEQUENCE users_public_id_seq START WITH 10000000;
    ALTER TABLE users ADD COLUMN public_id BIGINT;

    UPDATE users u
    SET public_id = numbered.public_id
    FROM (
      SELECT id, nextval('users_public_id_seq') AS public_id
      FROM (SELECT id FROM users ORDER BY created_at, id) ordered
    ) numbered
    WHERE numbered.id = u.id;

    ALTER TABLE users
      ALTER COLUMN public_id SET DEFAULT nextval('users_public_id_seq'),
      ALTER COLUMN public_id SET NOT NULL,
      ADD CONSTRAINT users_public_id_key UNIQUE (public_id);
    ALTER SEQUENCE users_public_id_seq OWNED BY users.public_id;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users DROP COLUMN IF EXISTS public_id;
    DROP SEQUENCE IF EXISTS users_public_id_seq;
  `);
};
