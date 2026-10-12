// Backfills users.referral_code for rows that predate signup-time code assignment
// (auth.service.ts createUserWithDevice -> assignReferralCode). Those users get `code: null` from
// GET /referral, which leaves the Refer screen with nothing to share or copy.
//
// Format and alphabet mirror src/modules/referral/referral-code.ts exactly — 'HP-' + 6 chars from a
// 32-char set with 0/O/1/I removed (11-REFERRAL.md §4), so a code read aloud or typed by hand is
// unambiguous. Duplicating the generator in SQL rather than shelling out to the app is deliberate:
// migrations run standalone in CI and on Render (`pnpm migrate:up:prod`) with no app bootstrap.
//
// The loop retries per row against the TEXT UNIQUE constraint on the column. With a 32^6 (~1.07e9)
// space and a user count many orders of magnitude below that, a collision is rare and a retry
// resolves it; 20 attempts is a safety bound, not an expected path.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    DECLARE
      alphabet CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      target   RECORD;
      candidate TEXT;
      attempt  INT;
      assigned BOOLEAN;
    BEGIN
      FOR target IN SELECT id FROM users WHERE referral_code IS NULL LOOP
        assigned := FALSE;
        FOR attempt IN 1..20 LOOP
          candidate := 'HP-';
          FOR i IN 1..6 LOOP
            candidate := candidate || substr(alphabet, floor(random() * length(alphabet))::int + 1, 1);
          END LOOP;

          BEGIN
            UPDATE users SET referral_code = candidate WHERE id = target.id;
            assigned := TRUE;
            EXIT;
          EXCEPTION WHEN unique_violation THEN
            -- collision, try another code
          END;
        END LOOP;

        IF NOT assigned THEN
          RAISE EXCEPTION 'Could not generate a unique referral code for user % after 20 attempts', target.id;
        END IF;
      END LOOP;
    END $$;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = () => {
  // Irreversible by design. The codes are now live: users have shared them and referred_by rows point
  // at them, so nulling them out would break invite links that already exist in the wild. There is
  // also no marker distinguishing a backfilled code from one issued at signup.
};
