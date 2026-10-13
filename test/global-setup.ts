import { Pool } from 'pg';
import { Redis } from 'ioredis';

// Runs once in the vitest main process, before any test file starts. Per-file `beforeAll` cannot do
// this: vitest runs test files in parallel threads, so a truncate inside one file would delete rows
// another file is mid-way through asserting on.
//
// Only tables that test runs *append* to are cleared. Reference data seeded by migrations
// (region_config, network_config, fx_rates, spin_config, admin_users, pgmigrations) is left alone —
// wiping it would leave every suite booting against an empty config and failing at the first
// `/config` call.
const DATA_TABLES = [
  'users',
  'admin_sessions',
  'user_identities',
  'password_credentials',
  'auth_events',
  'password_reset_tokens',
  'email_verification_tokens',
  'devices',
  'refresh_tokens',
  'coin_ledger',
  'wallets',
  'earning_events',
  'postback_logs',
  'rewarded_ad_intents',
  'redemptions',
  'redemption_status_history',
  'spin_history',
  'fraud_flags',
  'audit_log',
  'inbox_messages',
  'catalog_staging',
  'novel_import_chapters',
  'novel_import_jobs',
  'novel_read_progress',
  'novel_chapter_unlocks',
  'novel_library',
  'novel_chapter_revisions',
  'novel_chapters',
  'novel_category_links',
  'novels',
  'novel_categories',
] as const;

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://ainovel:ainovel@localhost:5432/ainovel';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

export async function setup(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const redisClients = [0, 1, 2, 3].map((db) => new Redis(REDIS_URL, { db }));
  try {
    // One statement so FK ordering never matters. CASCADE is safe here because every dependent table
    // is already in the list — nothing outside it references these rows.
    await pool.query(`TRUNCATE ${DATA_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await pool.end();
  }
  try {
    await Promise.all(redisClients.map((client) => client.flushdb()));
  } finally {
    await Promise.all(redisClients.map((client) => client.quit()));
  }
}
