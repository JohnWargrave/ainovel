import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { env } from '../config/env.js';
import type { DB } from './types.js';

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Pool size kept modest at Tier 0/1 scale; revisit alongside PgBouncer at 15 §3.
  max: 10,
});

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});

export async function closeDb(): Promise<void> {
  await db.destroy();
}
