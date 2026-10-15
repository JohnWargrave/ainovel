import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { db } from '../../src/db/index.js';
import { MemoryObjectStorage, setObjectStorage } from '../../src/modules/novel/storage.js';
import {
  getCoverBriefWriter,
  setCoverBriefWriter,
  type CoverBrief,
  type CoverBriefInput,
} from '../../src/modules/novel/cover-ai/brief.js';
import {
  setCoverImageGenerator,
  type CoverImageRequest,
} from '../../src/modules/novel/cover-ai/image-generator.js';
import {
  COVER_HEIGHT,
  COVER_WIDTH,
  composeCover,
} from '../../src/modules/novel/cover-ai/compose.js';
import { processCoverJob } from '../../src/modules/novel/cover-ai/service.js';
import { processImportJob } from '../../src/modules/novel/import/import.service.js';

const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

interface CoverJobBody {
  id: string;
  novel_id: string;
  status: string;
  trigger: string;
  prompt: string | null;
  errors: string[];
  candidates: {
    id: string;
    idx: number;
    url: string;
    clean_url: string;
    applied_at: string | null;
  }[];
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
    .values({ id: adminId, email: `cover-ai-${randomUUID()}@test.local`, role })
    .execute();
  return adminId;
}

const BRIEF: CoverBrief = {
  subject: 'a young swordsman',
  setting: 'misty mountains',
  mood: 'resolute',
  palette: 'jade and gold',
  style: 'ink painting',
  composition: 'figure upper center',
  prompt: 'A young swordsman on a misty mountain peak, ink painting, no text, no lettering',
};

class FakeBriefWriter {
  readonly calls: CoverBriefInput[] = [];
  write(input: CoverBriefInput): Promise<CoverBrief> {
    this.calls.push(input);
    return Promise.resolve(BRIEF);
  }
}

class FakeGenerator {
  readonly model = '@cf/test/fake-flux';
  readonly calls: CoverImageRequest[] = [];
  failAt = new Set<number>();
  async generate(request: CoverImageRequest): Promise<Buffer> {
    const call = this.calls.push(request) - 1;
    if (this.failAt.has(call)) throw new Error('render failed');
    return sharp({
      create: { width: request.width, height: request.height, channels: 3, background: '#2a4d69' },
    })
      .jpeg()
      .toBuffer();
  }
}

describe('AI cover generation', () => {
  let app: FastifyInstance;
  let editor: string;
  let analyst: string;
  const storage = new MemoryObjectStorage();
  let briefs: FakeBriefWriter;
  let generator: FakeGenerator;

  async function createNovel(title = 'Kiếm Đạo Độc Tôn'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/novels',
      headers: adminHeaders(editor),
      payload: { title, author: 'Tác Giả', description: 'Một thiếu niên luyện kiếm.' },
    });
    expect(res.statusCode).toBe(200);
    const novelId = res.json<{ id: string }>().id;
    await app.inject({
      method: 'POST',
      url: `/admin/novels/${novelId}/chapters`,
      headers: adminHeaders(editor),
      payload: { title: 'Chương 1', content: 'Trên đỉnh núi mù sương, Lâm Phong rút kiếm.' },
    });
    return novelId;
  }

  async function startJob(
    novelId: string,
    payload: Record<string, unknown> = {},
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: `/admin/novels/${novelId}/cover-jobs`,
      headers: adminHeaders(editor),
      payload,
    });
  }

  beforeAll(async () => {
    setObjectStorage(storage);
    app = await buildApp();
    await app.ready();
    editor = await createAdminUser('editor');
    analyst = await createAdminUser('analyst');
  });

  beforeEach(() => {
    briefs = new FakeBriefWriter();
    generator = new FakeGenerator();
    setCoverBriefWriter(briefs);
    setCoverImageGenerator(generator);
  });

  afterAll(async () => {
    setCoverBriefWriter(null);
    setCoverImageGenerator(null);
    setObjectStorage(null);
    await app.close();
  });

  it('generates four candidates and applies the one the admin picks', async () => {
    const novelId = await createNovel();
    const created = await startJob(novelId);
    expect(created.statusCode).toBe(202);
    const job = created.json<CoverJobBody>();
    expect(job).toMatchObject({ status: 'queued', trigger: 'manual', candidates: [] });

    await processCoverJob(job.id);

    expect(briefs.calls).toHaveLength(1);
    expect(briefs.calls[0]).toMatchObject({ title: 'Kiếm Đạo Độc Tôn', author: 'Tác Giả' });
    expect(briefs.calls[0]?.excerpt).toContain('Lâm Phong');
    expect(generator.calls.map((call) => [call.width, call.height])).toEqual(
      Array.from({ length: 4 }, () => [COVER_WIDTH, COVER_HEIGHT]),
    );
    expect(new Set(generator.calls.map((call) => call.seed)).size).toBe(4);

    const latest = await app.inject({
      method: 'GET',
      url: `/admin/novels/${novelId}/cover-jobs/latest`,
      headers: adminHeaders(editor, false),
    });
    const ready = latest.json<{ job: CoverJobBody }>().job;
    expect(ready.status).toBe('ready');
    expect(ready.prompt).toBe(BRIEF.prompt);
    expect(ready.candidates).toHaveLength(4);
    const candidateKeys = [...storage.objects.keys()].filter((key) =>
      key.startsWith(`covers/candidates/${job.id}/`),
    );
    expect(candidateKeys).toHaveLength(8);

    // The novel keeps its cover until a pick.
    const before = await db
      .selectFrom('novels')
      .select(['cover_key'])
      .where('id', '=', novelId)
      .executeTakeFirstOrThrow();
    expect(before.cover_key).toBeNull();

    const pick = ready.candidates[2]!;
    const applied = await app.inject({
      method: 'POST',
      url: `/admin/novel-cover-candidates/${pick.id}/apply`,
      headers: adminHeaders(editor),
    });
    expect(applied.statusCode).toBe(200);
    const novel = await db
      .selectFrom('novels')
      .select(['cover_key', 'cover_url'])
      .where('id', '=', novelId)
      .executeTakeFirstOrThrow();
    expect(novel.cover_key?.startsWith(`covers/${novelId}/`)).toBe(true);
    expect(novel.cover_key?.endsWith('.webp')).toBe(true);
    expect(novel.cover_url).toBe(`https://storage.invalid/${novel.cover_key ?? ''}`);
    expect(storage.objects.get(novel.cover_key ?? '')?.body).toEqual(
      storage.objects.get(`covers/candidates/${job.id}/2.webp`)?.body,
    );

    const audit = await db
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', novelId)
      .where('action', '=', 'NOVEL_COVER_AI_APPLIED')
      .execute();
    expect(audit).toHaveLength(1);

    const after = (
      await app.inject({
        method: 'GET',
        url: `/admin/novels/${novelId}/cover-jobs/latest`,
        headers: adminHeaders(editor, false),
      })
    ).json<{ job: CoverJobBody }>().job;
    expect(after.status).toBe('applied');
    expect(after.candidates[2]?.applied_at).not.toBeNull();

    // Picking another candidate replaces the cover and deletes the one it replaced.
    const firstKey = novel.cover_key ?? '';
    await app.inject({
      method: 'POST',
      url: `/admin/novel-cover-candidates/${after.candidates[0]!.id}/apply`,
      headers: adminHeaders(editor),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storage.objects.has(firstKey)).toBe(false);
  });

  it('uses the prompt the admin typed instead of asking the LLM', async () => {
    const novelId = await createNovel();
    const prompt = 'A red lantern over a dark river at night, painterly, no text';
    const job = (await startJob(novelId, { prompt: `  ${prompt}  ` })).json<CoverJobBody>();
    await processCoverJob(job.id);
    expect(briefs.calls).toHaveLength(0);
    expect(generator.calls.every((call) => call.prompt === prompt)).toBe(true);
  });

  it('keeps the renders that worked and fails only when none did', async () => {
    const novelId = await createNovel();
    generator.failAt = new Set([1]);
    const partial = (await startJob(novelId)).json<CoverJobBody>();
    await processCoverJob(partial.id);
    const row = await db
      .selectFrom('novel_cover_jobs')
      .select(['status'])
      .where('id', '=', partial.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('ready');
    const count = await db
      .selectFrom('novel_cover_candidates')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('job_id', '=', partial.id)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(3);

    generator = new FakeGenerator();
    generator.failAt = new Set([0, 1, 2, 3]);
    setCoverImageGenerator(generator);
    const failed = (await startJob(novelId)).json<CoverJobBody>();
    await processCoverJob(failed.id);
    const failedRow = await db
      .selectFrom('novel_cover_jobs')
      .select(['status', 'errors'])
      .where('id', '=', failed.id)
      .executeTakeFirstOrThrow();
    expect(failedRow.status).toBe('failed');
    // Internal error text stays in the log.
    expect(failedRow.errors).toEqual(['An image could not be generated']);
  });

  it('refuses a second job while one is running, and non-editors', async () => {
    const novelId = await createNovel();
    expect((await startJob(novelId)).statusCode).toBe(202);
    const again = await startJob(novelId);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe('COVER_JOB_IN_PROGRESS');

    const forbidden = await app.inject({
      method: 'POST',
      url: `/admin/novels/${novelId}/cover-jobs`,
      headers: adminHeaders(analyst),
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/admin/novels/${uuidv7()}/cover-jobs`,
          headers: adminHeaders(editor),
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });

  it('answers 503 when the AI keys are not configured', async () => {
    setCoverBriefWriter(null);
    setCoverImageGenerator(null);
    const novelId = await createNovel();
    const res = await startJob(novelId);
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('COVER_AI_NOT_CONFIGURED');
  });

  it('drafts covers for imported novels without one when enabled', async () => {
    env.COVER_AI_AUTO_ON_IMPORT = true;
    try {
      const boundary = `----cover${randomUUID()}`;
      const text = 'Chương 1\nMở đầu.\n\nChương 2\nTiếp theo.\n';
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="format"\r\n\r\ntxt\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nnew\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.txt"\r\n` +
            'Content-Type: text/plain\r\n\r\n',
        ),
        Buffer.from(text, 'utf8'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const created = await app.inject({
        method: 'POST',
        url: '/admin/novel-imports',
        headers: {
          ...adminHeaders(editor),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      const importJob = created.json<{ id: string }>();
      await processImportJob(importJob.id);
      const done = await app.inject({
        method: 'POST',
        url: `/admin/novel-imports/${importJob.id}/commit`,
        headers: adminHeaders(editor),
        payload: {},
      });
      const novelId = done.json<{ result_novel_ids: string[] }>().result_novel_ids[0] ?? '';
      const jobs = await db
        .selectFrom('novel_cover_jobs')
        .select(['trigger', 'status', 'admin_user_id'])
        .where('novel_id', '=', novelId)
        .execute();
      expect(jobs).toEqual([{ trigger: 'import', status: 'queued', admin_user_id: null }]);
    } finally {
      env.COVER_AI_AUTO_ON_IMPORT = false;
    }
  });
});

describe('composeCover', () => {
  it('produces 2:3 WebP covers with and without a long Vietnamese title', async () => {
    const raw = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: '#335' },
    })
      .png()
      .toBuffer();
    const cover = await composeCover(raw, {
      title: 'Đấu Phá Thương Khung: Hành Trình Vạn Dặm Của Thiếu Niên Mang Kiếm Cổ Xưa',
      author: 'Thiên Tằm Thổ Đậu',
    });
    for (const image of [cover.withText, cover.clean]) {
      const meta = await sharp(image).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: COVER_WIDTH, height: COVER_HEIGHT });
    }
    expect(cover.withText.equals(cover.clean)).toBe(false);
  });
});

describe('DeepSeek brief writer', () => {
  const input: CoverBriefInput = {
    title: 'Kiếm Đạo',
    author: null,
    description: 'Một thiếu niên luyện kiếm.',
    genres: ['Tiên hiệp'],
    tags: [],
    excerpt: 'Lâm Phong rút kiếm.',
  };
  const reply = (content: string | null, finishReason = 'stop', status = 200): Response =>
    new Response(
      JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] }),
      { status, headers: { 'content-type': 'application/json' } },
    );

  beforeAll(() => {
    env.DEEPSEEK_API_KEY = 'test-deepseek-key';
    setCoverBriefWriter(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(() => {
    delete env.DEEPSEEK_API_KEY;
  });

  it('asks for JSON without thinking and returns the brief', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(reply(JSON.stringify(BRIEF))));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getCoverBriefWriter().write(input)).resolves.toEqual(BRIEF);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer test-deepseek-key',
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
    });
    expect(JSON.stringify(body['messages'])).toContain('Lâm Phong');
  });

  it('retries an empty JSON-mode answer once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(''))
      .mockResolvedValueOnce(reply(JSON.stringify(BRIEF)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getCoverBriefWriter().write(input)).resolves.toEqual(BRIEF);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps a content filter to a 422 and an auth error to a 502 without retrying', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(reply(null, 'content_filter'))),
    );
    await expect(getCoverBriefWriter().write(input)).rejects.toMatchObject({
      code: 'COVER_AI_BRIEF_REFUSED',
      statusCode: 422,
    });
    const unauthorized = vi.fn(() => Promise.resolve(reply(null, 'stop', 401)));
    vi.stubGlobal('fetch', unauthorized);
    await expect(getCoverBriefWriter().write(input)).rejects.toMatchObject({
      code: 'COVER_AI_BRIEF_FAILED',
      statusCode: 502,
    });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
});
