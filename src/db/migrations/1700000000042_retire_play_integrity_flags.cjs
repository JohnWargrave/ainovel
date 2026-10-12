// Play Integrity is no longer part of authentication or welcome-credit eligibility. Retire its
// historical D02/D03 signals and refresh cached scores without altering unrelated fraud flags.
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TEMP TABLE retired_play_integrity_users ON COMMIT DROP AS
      SELECT DISTINCT user_id
      FROM fraud_flags
      WHERE rule_code IN ('D02', 'D03');

    UPDATE fraud_flags
    SET status = 'dismissed'
    WHERE rule_code IN ('D02', 'D03')
      AND status IN ('open', 'confirmed');

    UPDATE users u
    SET fraud_score = LEAST(100, ROUND(COALESCE((
      SELECT SUM(
        f.severity * 10 * GREATEST(
          0,
          1 - EXTRACT(EPOCH FROM (now() - f.created_at)) / (30 * 24 * 60 * 60)
        )
      )
      FROM fraud_flags f
      WHERE f.user_id = u.id
        AND f.status IN ('open', 'confirmed')
    ), 0)))::smallint
    WHERE u.id IN (SELECT user_id FROM retired_play_integrity_users);
  `);
};

exports.down = () => {
  // D02/D03 review state cannot be reconstructed safely; rollback is deliberately a no-op.
};
