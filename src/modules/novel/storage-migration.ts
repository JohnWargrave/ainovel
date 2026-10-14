import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { sql } from 'kysely';
import { db } from '../../db/index.js';

// One-off move of covers and import files between S3-compatible stores (SeaweedFS -> Cloudflare R2).
// Driven by src/cli/migrate-object-storage.ts; kept here so the pieces can be tested on their own.

export interface BucketRef {
  client: S3Client;
  bucket: string;
}

export interface CopyReport {
  copied: number;
  skipped: number;
  failed: { key: string; error: string }[];
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

// Size of the object at the destination, or null when it is not there yet.
async function destinationSize(target: BucketRef, key: string): Promise<number | null> {
  try {
    const head = await target.client.send(
      new HeadObjectCommand({ Bucket: target.bucket, Key: key }),
    );
    return head.ContentLength ?? 0;
  } catch (err) {
    if (errorName(err) === 'NotFound' || errorName(err) === 'NoSuchKey') return null;
    throw err;
  }
}

// Copies every object, keeping its Content-Type and Cache-Control. An object already at the
// destination with the same size is skipped, so an interrupted run can simply be started again.
// One failing key is recorded and the run goes on; the caller decides what a failure means.
export async function copyAllObjects(
  source: BucketRef,
  target: BucketRef,
  options: { dryRun: boolean; onProgress?: (key: string, action: 'copy' | 'skip') => void },
): Promise<CopyReport> {
  const report: CopyReport = { copied: 0, skipped: 0, failed: [] };
  let continuationToken: string | undefined;
  do {
    const page = await source.client.send(
      new ListObjectsV2Command({ Bucket: source.bucket, ContinuationToken: continuationToken }),
    );
    for (const entry of page.Contents ?? []) {
      const key = entry.Key;
      if (!key) continue;
      try {
        if ((await destinationSize(target, key)) === (entry.Size ?? 0)) {
          report.skipped += 1;
          options.onProgress?.(key, 'skip');
          continue;
        }
        if (!options.dryRun) {
          const object = await source.client.send(
            new GetObjectCommand({ Bucket: source.bucket, Key: key }),
          );
          if (!object.Body) throw new Error('Source object has no body');
          await target.client.send(
            new PutObjectCommand({
              Bucket: target.bucket,
              Key: key,
              Body: Buffer.from(await object.Body.transformToByteArray()),
              ContentType: object.ContentType,
              CacheControl: object.CacheControl,
            }),
          );
        }
        report.copied += 1;
        options.onProgress?.(key, 'copy');
      } catch (err) {
        report.failed.push({ key, error: err instanceof Error ? err.message : String(err) });
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return report;
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/u, '');
}

// novels.cover_url holds an absolute URL under the old public base. Only URLs under that base are
// rewritten: an operator may have pasted an outside cover URL while a stale cover_key remains, so
// rebuilding every URL from cover_key would overwrite those.
export async function rewriteCoverUrls(
  fromBase: string,
  toBase: string,
  options: { dryRun: boolean },
): Promise<number> {
  const from = `${trimSlashes(fromBase)}/`;
  const to = `${trimSlashes(toBase)}/`;
  // starts_with rather than LIKE: a base URL can contain _ or %, which LIKE would treat as wildcards.
  const matching = sql<boolean>`starts_with(cover_url, ${from})`;
  if (options.dryRun) {
    const row = await db
      .selectFrom('novels')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where(matching)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
  const result = await db
    .updateTable('novels')
    .set({ cover_url: sql<string>`${to} || substr(cover_url, ${from.length + 1})` })
    .where(matching)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
