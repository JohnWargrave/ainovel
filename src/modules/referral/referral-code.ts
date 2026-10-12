import { randomInt } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { DB } from '../../db/types.js';

// Excludes 0/O/1/I to avoid visual ambiguity when a user reads/types the code out loud or by hand
// (11-REFERRAL.md §4: format "HP-XXXXXX").
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 5;

export function generateReferralCode(): string {
  const chars: string[] = [];
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    chars.push(ALPHABET.charAt(randomInt(0, ALPHABET.length)));
  }
  return `HP-${chars.join('')}`;
}

// Called inside the caller's signup transaction so the returned code can be inserted directly into
// the same `users` row — no separate referral_code table needed since the column already exists.
export async function assignReferralCode(trx: Transaction<DB>): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const code = generateReferralCode();
    const existing = await trx
      .selectFrom('users')
      .select('id')
      .where('referral_code', '=', code)
      .executeTakeFirst();
    if (!existing) return code;
  }
  throw new Error('Unable to generate a unique referral code after several attempts');
}
