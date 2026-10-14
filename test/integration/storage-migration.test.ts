import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { uuidv7 } from 'uuidv7';
import { db } from '../../src/db/index.js';
import { copyAllObjects, rewriteCoverUrls } from '../../src/modules/novel/storage-migration.js';

interface StoredObject {
  body: Buffer;
  contentType?: string;
  cacheControl?: string;
}

// Just enough of an S3 bucket for the copy loop: paged listing, head, get and put.
function fakeBucket(
  objects: Map<string, StoredObject>,
  options: { pageSize?: number; failPutFor?: string } = {},
): S3Client {
  const pageSize = options.pageSize ?? 1000;
  const send = (command: unknown): Promise<unknown> => {
    if (command instanceof ListObjectsV2Command) {
      const keys = [...objects.keys()].sort();
      const start = Number(command.input.ContinuationToken ?? 0);
      const slice = keys.slice(start, start + pageSize);
      const next = start + pageSize;
      return Promise.resolve({
        Contents: slice.map((key) => ({ Key: key, Size: objects.get(key)!.body.length })),
        IsTruncated: next < keys.length,
        NextContinuationToken: String(next),
      });
    }
    if (command instanceof HeadObjectCommand) {
      const object = objects.get(command.input.Key!);
      if (!object) return Promise.reject(Object.assign(new Error('missing'), { name: 'NotFound' }));
      return Promise.resolve({ ContentLength: object.body.length });
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(command.input.Key!)!;
      return Promise.resolve({
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(object.body)) },
        ContentType: object.contentType,
        CacheControl: object.cacheControl,
      });
    }
    if (command instanceof PutObjectCommand) {
      if (command.input.Key === options.failPutFor) return Promise.reject(new Error('put refused'));
      objects.set(command.input.Key!, {
        body: command.input.Body as Buffer,
        ...(command.input.ContentType ? { contentType: command.input.ContentType } : {}),
        ...(command.input.CacheControl ? { cacheControl: command.input.CacheControl } : {}),
      });
      return Promise.resolve({});
    }
    return Promise.reject(new Error('unexpected command'));
  };
  return { send } as unknown as S3Client;
}

describe('object storage migration', () => {
  describe('copyAllObjects', () => {
    it('copies every page of objects with their headers and skips what is already there', async () => {
      const source = new Map<string, StoredObject>([
        [
          'covers/a.jpg',
          {
            body: Buffer.from('aaa'),
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=31536000, immutable',
          },
        ],
        ['covers/b.png', { body: Buffer.from('bbbb'), contentType: 'image/png' }],
        ['imports/c.epub', { body: Buffer.from('ccccc'), contentType: 'application/octet-stream' }],
      ]);
      const target = new Map<string, StoredObject>([
        ['covers/b.png', { body: Buffer.from('bbbb') }],
      ]);

      const report = await copyAllObjects(
        { client: fakeBucket(source, { pageSize: 2 }), bucket: 'old' },
        { client: fakeBucket(target), bucket: 'new' },
        { dryRun: false },
      );

      expect(report).toEqual({ copied: 2, skipped: 1, failed: [] });
      expect(target.get('covers/a.jpg')).toEqual(source.get('covers/a.jpg'));
      expect(target.get('imports/c.epub')?.body.toString()).toBe('ccccc');

      const again = await copyAllObjects(
        { client: fakeBucket(source, { pageSize: 2 }), bucket: 'old' },
        { client: fakeBucket(target), bucket: 'new' },
        { dryRun: false },
      );
      expect(again).toEqual({ copied: 0, skipped: 3, failed: [] });
    });

    it('recopies an object whose size differs, writes nothing on a dry run and records failures', async () => {
      const source = new Map<string, StoredObject>([
        ['covers/a.jpg', { body: Buffer.from('new-bytes') }],
        ['covers/b.jpg', { body: Buffer.from('b') }],
      ]);
      const target = new Map<string, StoredObject>([
        ['covers/a.jpg', { body: Buffer.from('old') }],
      ]);

      const dry = await copyAllObjects(
        { client: fakeBucket(source), bucket: 'old' },
        { client: fakeBucket(target), bucket: 'new' },
        { dryRun: true },
      );
      expect(dry).toEqual({ copied: 2, skipped: 0, failed: [] });
      expect(target.get('covers/a.jpg')?.body.toString()).toBe('old');
      expect(target.has('covers/b.jpg')).toBe(false);

      const real = await copyAllObjects(
        { client: fakeBucket(source), bucket: 'old' },
        { client: fakeBucket(target, { failPutFor: 'covers/b.jpg' }), bucket: 'new' },
        { dryRun: false },
      );
      expect(real.copied).toBe(1);
      expect(real.failed).toEqual([{ key: 'covers/b.jpg', error: 'put refused' }]);
      expect(target.get('covers/a.jpg')?.body.toString()).toBe('new-bytes');
    });
  });

  describe('rewriteCoverUrls', () => {
    // A host of its own per run so parallel suites' novels never match. The underscore checks the
    // base is matched literally, not as a LIKE wildcard.
    const oldBase = `https://old_${randomUUID().slice(0, 8)}.example/media`;
    const newBase = `https://r2-${randomUUID().slice(0, 8)}.example`;
    const ids: string[] = [];

    async function insertNovel(coverUrl: string | null): Promise<string> {
      const id = uuidv7();
      ids.push(id);
      await db
        .insertInto('novels')
        .values({
          id,
          slug: `novel-${randomUUID().slice(0, 12)}`,
          title: 'Storage move',
          author: 'Author',
          translator: null,
          description: null,
          cover_url: coverUrl,
          cover_key: coverUrl ? 'covers/x.jpg' : null,
          status: 'published',
          regions: null,
          vip_from_chapter: null,
          default_unlock_coin: 50,
          allow_ad_unlock: true,
          chapter_count: 0,
          published_at: new Date(),
          created_by: null,
        })
        .execute();
      return id;
    }

    async function coverOf(id: string): Promise<string | null> {
      const row = await db
        .selectFrom('novels')
        .select('cover_url')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return row.cover_url;
    }

    afterAll(async () => {
      if (ids.length > 0) await db.deleteFrom('novels').where('id', 'in', ids).execute();
    });

    it('moves only URLs under the old base, and a dry run only counts them', async () => {
      const stored = await insertNovel(`${oldBase}/covers/2026/a.jpg`);
      const outside = await insertNovel('https://cdn.elsewhere.example/cover.jpg');
      const lookalike = await insertNovel(`${oldBase.replace('old_', 'oldX')}/covers/b.jpg`);
      const none = await insertNovel(null);

      expect(await rewriteCoverUrls(`${oldBase}/`, newBase, { dryRun: true })).toBe(1);
      expect(await coverOf(stored)).toBe(`${oldBase}/covers/2026/a.jpg`);

      expect(await rewriteCoverUrls(oldBase, `${newBase}/`, { dryRun: false })).toBe(1);
      expect(await coverOf(stored)).toBe(`${newBase}/covers/2026/a.jpg`);
      expect(await coverOf(outside)).toBe('https://cdn.elsewhere.example/cover.jpg');
      expect(await coverOf(lookalike)).toBe(`${oldBase.replace('old_', 'oldX')}/covers/b.jpg`);
      expect(await coverOf(none)).toBeNull();

      // Re-running finds nothing left under the old base.
      expect(await rewriteCoverUrls(oldBase, newBase, { dryRun: false })).toBe(0);
    });
  });
});
