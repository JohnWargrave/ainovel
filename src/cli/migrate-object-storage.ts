import { closeDb } from '../db/index.js';
import { env } from '../config/env.js';
import { createS3Client, s3ConfigFromEnv } from '../modules/novel/storage.js';
import { copyAllObjects, rewriteCoverUrls } from '../modules/novel/storage-migration.js';

// Copies every object from the old store (SOURCE_S3_*) into the one the app is configured for
// (S3_*), then points novels.cover_url at the new public base. Run it with the new S3_* already
// set (e.g. Cloudflare R2) and the old SeaweedFS still up:
//
//   SOURCE_S3_ENDPOINT=http://seaweedfs:8333 SOURCE_S3_BUCKET=ainovel \
//   SOURCE_S3_ACCESS_KEY_ID=... SOURCE_S3_SECRET_ACCESS_KEY=... SOURCE_S3_FORCE_PATH_STYLE=true \
//   SOURCE_S3_PUBLIC_BASE_URL=https://api.example.com/media \
//   node dist/cli/migrate-object-storage.js [--dry-run]
//
// Safe to re-run: objects already copied are skipped, and cover URLs already rewritten no longer
// match the old base. Cover URLs are only rewritten when every object copied.

const dryRun = process.argv.includes('--dry-run');
const source = {
  endpoint: process.env['SOURCE_S3_ENDPOINT'],
  region: process.env['SOURCE_S3_REGION'] ?? 'us-east-1',
  bucket: process.env['SOURCE_S3_BUCKET'],
  accessKeyId: process.env['SOURCE_S3_ACCESS_KEY_ID'],
  secretAccessKey: process.env['SOURCE_S3_SECRET_ACCESS_KEY'],
  forcePathStyle: process.env['SOURCE_S3_FORCE_PATH_STYLE'] === 'true',
  publicBaseUrl: process.env['SOURCE_S3_PUBLIC_BASE_URL'],
};

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!source.bucket || !source.publicBaseUrl) {
  fail(
    'Set SOURCE_S3_BUCKET and SOURCE_S3_PUBLIC_BASE_URL (plus endpoint/keys) for the old store.',
  );
}
if (!env.S3_BUCKET || !env.S3_PUBLIC_BASE_URL) {
  fail('Set S3_BUCKET and S3_PUBLIC_BASE_URL (plus endpoint/keys) for the new store.');
}
if (
  source.endpoint === env.S3_ENDPOINT &&
  source.bucket === env.S3_BUCKET &&
  source.publicBaseUrl === env.S3_PUBLIC_BASE_URL
) {
  fail('Source and destination are the same store; nothing to migrate.');
}

const prefix = dryRun ? '[dry run] ' : '';
process.stdout.write(
  `${prefix}Copying ${source.endpoint ?? 'AWS'}/${source.bucket} -> ${env.S3_ENDPOINT ?? 'AWS'}/${env.S3_BUCKET}\n`,
);

const report = await copyAllObjects(
  { client: createS3Client(source), bucket: source.bucket },
  { client: createS3Client(s3ConfigFromEnv()), bucket: env.S3_BUCKET },
  {
    dryRun,
    onProgress: (key, action) => {
      if (action === 'copy') process.stdout.write(`${prefix}copy ${key}\n`);
    },
  },
);
process.stdout.write(
  `${prefix}${String(report.copied)} copied, ${String(report.skipped)} already there, ${String(report.failed.length)} failed\n`,
);
for (const failure of report.failed) {
  process.stderr.write(`  failed ${failure.key}: ${failure.error}\n`);
}

if (report.failed.length > 0) {
  process.stderr.write('Cover URLs left unchanged; fix the failures and run again.\n');
  process.exitCode = 1;
} else {
  const rewritten = await rewriteCoverUrls(source.publicBaseUrl, env.S3_PUBLIC_BASE_URL, {
    dryRun,
  });
  process.stdout.write(
    `${prefix}${String(rewritten)} cover URL(s) ${dryRun ? 'would move' : 'moved'} to ${env.S3_PUBLIC_BASE_URL}\n`,
  );
}

await closeDb();
