import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { MemoryObjectStorage, setObjectStorage } from '../../src/modules/novel/storage.js';
import { processImportJob } from '../../src/modules/novel/import/import.service.js';
import { parseImport } from '../../src/modules/novel/import/parsers.js';

const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

interface AdminNovelBody {
  id: string;
  slug: string;
  title: string;
  status: string;
  chapter_count: number;
  cover_url: string | null;
  vip_from_chapter: number | null;
}

interface AdminChapterBody {
  id: string;
  chapter_no: number;
  title: string;
  word_count: number;
  is_vip: boolean | null;
  effective_vip: boolean;
  status: string;
}

interface ImportJobBody {
  id: string;
  status: string;
  format: string;
  errors: string[];
  preview: { novels: { title: string; chapter_count: number }[] } | null;
  result_novel_ids: string[];
}

function adminHeaders(adminUserId: string, withCsrf = true): Record<string, string> {
  return {
    'x-admin-api-key': ADMIN_API_KEY,
    'x-admin-user-id': adminUserId,
    ...(withCsrf ? { 'x-csrf-token': ADMIN_CSRF_TOKEN } : {}),
  };
}

async function createAdminUser(role: string): Promise<string> {
  const adminId = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id: adminId, email: `novel-cms-${randomUUID()}@test.local`, role })
    .execute();
  return adminId;
}

function multipart(
  fields: Record<string, string>,
  file: { name: string; contentType: string; data: Buffer },
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----novel${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

// Smallest valid PNG: signature + IHDR + IEND is enough for magic-byte detection.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);

describe('novel CMS', () => {
  let app: FastifyInstance;
  let editor: string;
  let analyst: string;
  let superadmin: string;
  const storage = new MemoryObjectStorage();

  beforeAll(async () => {
    setObjectStorage(storage);
    app = await buildApp();
    editor = await createAdminUser('editor');
    analyst = await createAdminUser('analyst');
    superadmin = await createAdminUser('superadmin');
  });

  afterAll(async () => {
    setObjectStorage(null);
    await app.close();
  });

  async function createNovel(
    adminId: string,
    payload: Record<string, unknown>,
  ): Promise<AdminNovelBody> {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/novels',
      headers: adminHeaders(adminId),
      payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json<AdminNovelBody>();
  }

  async function createChapter(
    novelId: string,
    payload: Record<string, unknown>,
  ): Promise<AdminChapterBody> {
    const res = await app.inject({
      method: 'POST',
      url: `/admin/novels/${novelId}/chapters`,
      headers: adminHeaders(editor),
      payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json<AdminChapterBody>();
  }

  describe('roles', () => {
    it('lets an analyst read stats but not edit content', async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/admin/novels/stats/top',
        headers: adminHeaders(analyst, false),
      });
      expect(list.statusCode).toBe(200);

      const create = await app.inject({
        method: 'POST',
        url: '/admin/novels',
        headers: adminHeaders(analyst),
        payload: { title: 'Nope' },
      });
      expect(create.statusCode).toBe(403);
    });

    it('keeps reward settings superadmin-only', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/novel/settings',
        headers: adminHeaders(editor, false),
      });
      expect(res.statusCode).toBe(403);
    });

    it('requires the CSRF token on mutations', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/novels',
        headers: adminHeaders(editor, false),
        payload: { title: 'No CSRF' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('novels and chapters', () => {
    it('creates a draft novel with a slug and appends chapters with server-side word counts', async () => {
      const novel = await createNovel(editor, { title: `Đấu Phá ${randomUUID().slice(0, 6)}` });
      expect(novel.status).toBe('draft');
      expect(novel.slug).toMatch(/^dau-pha-/u);

      const first = await createChapter(novel.id, { title: 'One', content: 'một hai ba bốn' });
      // Drafts don't count toward the reader-facing chapter_count.
      const second = await createChapter(novel.id, {
        title: 'Two',
        content: 'five six',
        status: 'published',
      });
      expect(first).toMatchObject({ chapter_no: 1, word_count: 4 });
      expect(second).toMatchObject({ chapter_no: 2, word_count: 2 });

      const duplicate = await app.inject({
        method: 'POST',
        url: `/admin/novels/${novel.id}/chapters`,
        headers: adminHeaders(editor),
        payload: { chapter_no: 2, content: 'clash' },
      });
      expect(duplicate.statusCode).toBe(409);

      const got = await app.inject({
        method: 'GET',
        url: `/admin/novels/${novel.id}`,
        headers: adminHeaders(editor, false),
      });
      expect(got.json<AdminNovelBody>().chapter_count).toBe(1);
    });

    it('derives effective VIP from the novel policy and per-chapter overrides', async () => {
      const novel = await createNovel(editor, { title: 'VIP policy', vip_from_chapter: 2 });
      const one = await createChapter(novel.id, { content: 'a' });
      const two = await createChapter(novel.id, { content: 'b' });
      expect(one.effective_vip).toBe(false);
      expect(two.effective_vip).toBe(true);

      const bulk = await app.inject({
        method: 'POST',
        url: `/admin/novels/${novel.id}/chapters/bulk`,
        headers: adminHeaders(editor),
        payload: { ids: [one.id], action: 'set_vip' },
      });
      expect(bulk.statusCode).toBe(200);
      const after = await app.inject({
        method: 'GET',
        url: `/admin/novels/${novel.id}/chapters/${one.id}`,
        headers: adminHeaders(editor, false),
      });
      expect(after.json<AdminChapterBody>()).toMatchObject({ is_vip: true, effective_vip: true });
    });

    it('keeps a revision on every content edit and restores it', async () => {
      const novel = await createNovel(editor, { title: 'Revisions' });
      const chapter = await createChapter(novel.id, { title: 'Draft', content: 'original text' });

      const update = await app.inject({
        method: 'POST',
        url: `/admin/novels/${novel.id}/chapters/${chapter.id}`,
        headers: adminHeaders(editor),
        payload: { content: 'rewritten text here' },
      });
      expect(update.statusCode).toBe(200);
      expect(update.json<AdminChapterBody>().word_count).toBe(3);

      const revisions = await app.inject({
        method: 'GET',
        url: `/admin/novels/${novel.id}/chapters/${chapter.id}/revisions`,
        headers: adminHeaders(editor, false),
      });
      const items = revisions.json<{ items: { id: string }[] }>().items;
      expect(items.length).toBeGreaterThanOrEqual(1);
      const original = items[items.length - 1];

      const restore = await app.inject({
        method: 'POST',
        url: `/admin/novels/${novel.id}/chapters/${chapter.id}/revisions/${original?.id ?? ''}/restore`,
        headers: adminHeaders(editor),
      });
      expect(restore.statusCode).toBe(200);
      const restored = await db
        .selectFrom('novel_chapters')
        .select('content')
        .where('id', '=', chapter.id)
        .executeTakeFirstOrThrow();
      expect(restored.content).toBe('original text');
    });

    it('publishes in bulk and writes an audit entry', async () => {
      const novel = await createNovel(editor, { title: 'Bulk publish' });
      const res = await app.inject({
        method: 'POST',
        url: '/admin/novels/bulk',
        headers: adminHeaders(editor),
        payload: { ids: [novel.id], action: 'publish' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ updated: number }>().updated).toBe(1);

      const row = await db
        .selectFrom('novels')
        .select(['status', 'published_at'])
        .where('id', '=', novel.id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('published');
      expect(row.published_at).not.toBeNull();

      const audit = await db
        .selectFrom('audit_log')
        .select('action')
        .where('target_id', '=', novel.id)
        .execute();
      expect(audit.map((entry) => entry.action)).toEqual(expect.arrayContaining(['NOVEL_CREATED']));
    });

    it('uploads a cover image to object storage and rejects non-images', async () => {
      const novel = await createNovel(editor, { title: 'Cover' });
      const good = multipart({}, { name: 'cover.png', contentType: 'image/png', data: PNG });
      const res = await app.inject({
        method: 'POST',
        url: `/admin/novels/${novel.id}/cover`,
        headers: { ...adminHeaders(editor), ...good.headers },
        payload: good.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<AdminNovelBody>().cover_url).toContain(`covers/${novel.id}/`);

      const bad = multipart(
        {},
        { name: 'cover.png', contentType: 'image/png', data: Buffer.from('not an image') },
      );
      const rejected = await app.inject({
        method: 'POST',
        url: `/admin/novels/${novel.id}/cover`,
        headers: { ...adminHeaders(editor), ...bad.headers },
        payload: bad.payload,
      });
      expect(rejected.statusCode).toBe(400);
    });

    it('exports a novel as JSON', async () => {
      const novel = await createNovel(editor, { title: 'Export me' });
      await createChapter(novel.id, { title: 'Only', content: 'hello world' });
      const res = await app.inject({
        method: 'GET',
        url: `/admin/novels/${novel.id}/export?format=json`,
        headers: adminHeaders(editor, false),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      const body = res.json<{ novel: { title: string }; chapters: { content: string }[] }>();
      expect(body.novel.title).toBe('Export me');
      expect(body.chapters).toEqual([expect.objectContaining({ content: 'hello world' })]);
    });
  });

  describe('reward settings', () => {
    it('updates a region and exposes it through /config features', async () => {
      const regionId = `N_${randomUUID().slice(0, 8)}`;
      await db
        .insertInto('region_config')
        .values({ region_id: regionId, countries: [], features: { timezone: 'UTC' } })
        .execute();

      const res = await app.inject({
        method: 'PUT',
        url: `/admin/novel/settings/${regionId}`,
        headers: adminHeaders(superadmin),
        payload: {
          enabled: true,
          chapter_reward_coin: 7,
          reading_wpm: 250,
          min_read_ratio: 0.6,
          min_read_seconds: 20,
          max_read_seconds: 600,
          completion_scroll_ratio: 0.85,
          chapter_reward_daily_cap: 15,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ region_id: regionId, chapter_reward_coin: 7 });

      const stored = await db
        .selectFrom('region_config')
        .select('features')
        .where('region_id', '=', regionId)
        .executeTakeFirstOrThrow();
      expect((stored.features as { novel?: unknown }).novel).toMatchObject({
        enabled: true,
        chapter_reward_coin: 7,
      });
    });

    it('rejects out-of-range values', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/novel/settings/VN',
        headers: adminHeaders(superadmin),
        payload: {
          enabled: true,
          chapter_reward_coin: -1,
          reading_wpm: 250,
          min_read_ratio: 0.6,
          min_read_seconds: 20,
          max_read_seconds: 600,
          completion_scroll_ratio: 0.85,
          chapter_reward_daily_cap: 15,
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('import', () => {
    it('parses a TXT upload into a preview and commits it as a new draft novel', async () => {
      const text = [
        'Chương 1: Khởi đầu',
        'Đoạn văn thứ nhất của chương một.',
        '',
        'Chương 2: Tiếp theo',
        'Nội dung chương hai ở đây.',
      ].join('\n');
      const upload = multipart(
        { format: 'txt', mode: 'new' },
        { name: 'truyen-test.txt', contentType: 'text/plain', data: Buffer.from(text, 'utf8') },
      );
      const created = await app.inject({
        method: 'POST',
        url: '/admin/novel-imports',
        headers: { ...adminHeaders(editor), ...upload.headers },
        payload: upload.payload,
      });
      expect(created.statusCode).toBe(200);
      const job = created.json<ImportJobBody>();
      expect(job.status).toBe('queued');

      // The worker normally runs this off the BullMQ queue.
      await processImportJob(job.id);

      const ready = await app.inject({
        method: 'GET',
        url: `/admin/novel-imports/${job.id}`,
        headers: adminHeaders(editor, false),
      });
      const preview = ready.json<ImportJobBody>();
      expect(preview.status).toBe('ready');
      expect(preview.preview?.novels[0]?.chapter_count).toBe(2);

      const commit = await app.inject({
        method: 'POST',
        url: `/admin/novel-imports/${job.id}/commit`,
        headers: adminHeaders(editor),
        payload: { novels: [{ index: 0, title: 'Truyện nhập thử' }] },
      });
      expect(commit.statusCode).toBe(200);
      const done = commit.json<ImportJobBody>();
      expect(done.status).toBe('done');
      const novelId = done.result_novel_ids[0] ?? '';

      const novel = await db
        .selectFrom('novels')
        .select(['title', 'status', 'chapter_count'])
        .where('id', '=', novelId)
        .executeTakeFirstOrThrow();
      expect(novel).toEqual({ title: 'Truyện nhập thử', status: 'draft', chapter_count: 2 });

      // Committing twice must not import twice.
      const again = await app.inject({
        method: 'POST',
        url: `/admin/novel-imports/${job.id}/commit`,
        headers: adminHeaders(editor),
        payload: {},
      });
      expect(again.statusCode).toBeGreaterThanOrEqual(400);
    });
  });
});

describe('import parsers', () => {
  it('splits TXT on Vietnamese and English chapter headings', async () => {
    const text = 'Lời mở đầu\n\nChương 1\nA b c.\n\nChapter 2: Two\nD e.\n';
    const [novel] = await parseImport('txt', Buffer.from(text, 'utf8'), { fallbackTitle: 'T' });
    expect(novel?.chapters.map((chapter) => chapter.title)).toEqual(
      expect.arrayContaining(['Chương 1', 'Chapter 2: Two']),
    );
  });

  it('honours an admin-supplied chapter pattern', async () => {
    const text = '=== Một ===\nx\n=== Hai ===\ny\n';
    const [novel] = await parseImport('txt', Buffer.from(text, 'utf8'), {
      fallbackTitle: 'T',
      chapterPattern: '^=== .+ ===$',
    });
    expect(novel?.chapters).toHaveLength(2);
  });

  it('decodes UTF-16 text files', async () => {
    const text = '﻿Chương 1\nXin chào\n';
    const [novel] = await parseImport('txt', Buffer.from(text, 'utf16le'), { fallbackTitle: 'T' });
    expect(novel?.chapters[0]?.content).toContain('Xin chào');
  });

  it('reads the system ZIP format (novel.json + chapter files)', async () => {
    const zip = new JSZip();
    zip.file(
      'novel.json',
      JSON.stringify({
        format: 'ainovel-novel',
        version: 1,
        novel: { title: 'Zipped', author: 'Someone' },
        chapters: [
          { chapter_no: 1, title: 'One', file: 'chapters/0001.md' },
          { chapter_no: 2, title: 'Two', content: 'inline body' },
        ],
      }),
    );
    zip.file('chapters/0001.md', 'file body');
    const data = await zip.generateAsync({ type: 'nodebuffer' });
    const [novel] = await parseImport('zip', data, { fallbackTitle: 'T' });
    expect(novel?.title).toBe('Zipped');
    expect(novel?.chapters.map((chapter) => chapter.content)).toEqual(['file body', 'inline body']);
  });
});
