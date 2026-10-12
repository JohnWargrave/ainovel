// There is no username column on `users` — the app still needs a stable label for the profile
// header and the public recent-wins strip. Deriving it from the id keeps both surfaces showing the
// same name for the same person; two independent copies of this logic previously disagreed on the
// suffix length and rendered one user under two names.
//
// Safe to expose publicly: it leaks only the tail of a uuidv7, never the full id.
const SUFFIX_LENGTH = 6;

export function displayName(userId: string): string {
  return `Player_${userId.replace(/-/g, '').slice(-SUFFIX_LENGTH)}`;
}
