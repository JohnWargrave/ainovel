import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import type { ChatResult } from '../../src/modules/novel/ai/deepseek-chat.js';
import { AppError } from '../../src/lib/errors.js';
import {
  setNovelGenLlm,
  type NovelGenLlm,
  type NovelGenRequest,
} from '../../src/modules/novel/generate/llm.js';
import { processGenJob } from '../../src/modules/novel/generate/service.js';

const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

interface Project {
  id: string;
  title: string;
  status: string;
  task: string;
  busy: boolean;
  novel_id: string | null;
  input: { chapter_count: number; words_per_chapter: number; genres: string[] };
  bible: {
    title: string;
    description: string;
    tags: string[];
    characters: { name: string }[];
  } | null;
  outline: {
    arcs: { title: string; from_chapter: number; to_chapter: number }[];
    chapters: { no: number; title: string; beats: string[]; locked: boolean }[];
  } | null;
  write_next: number | null;
  live_text: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  errors: string[];
  written: { chapter_no: number; id: string; status: string; word_count: number }[];
}

const BIBLE = {
  title: 'Kiếm Đạo Độc Tôn',
  logline: 'Một thiếu niên bị phế kinh mạch tìm lại con đường kiếm đạo.',
  description: 'Lâm Phong, đệ tử ngoại môn bị coi là phế vật, nhặt được một thanh kiếm gãy…',
  setting: 'Đại lục Thiên Huyền',
  world_rules: 'Tu luyện chia chín cảnh giới.',
  tone: 'Ngôi thứ ba, nhịp nhanh',
  themes: ['kiên trì', 'báo thù'],
  tags: ['tu tiên', 'phế vật nghịch tập'],
  characters: [
    {
      name: 'Lâm Phong',
      role: 'protagonist',
      description: 'Thiếu niên ít nói',
      goal: 'Trở thành kiếm tôn',
      relationships: '',
    },
    {
      name: 'Tô Nguyệt',
      role: 'love interest',
      description: 'Thánh nữ',
      goal: '',
      relationships: 'Bạn thuở nhỏ',
    },
  ],
};

const usage = { prompt_tokens: 100, completion_tokens: 50 };

function json(value: unknown): ChatResult {
  return { content: JSON.stringify(value), finishReason: 'stop', usage };
}

// Answers by what the system prompt asks for, the way DeepSeek would.
class FakeLlm implements NovelGenLlm {
  readonly model = 'fake-novel-model';
  readonly calls: NovelGenRequest[] = [];
  chapter: ((request: NovelGenRequest) => Promise<ChatResult>) | null = null;

  async complete(request: NovelGenRequest): Promise<ChatResult> {
    this.calls.push(request);
    if (request.kind === 'chapter') {
      if (this.chapter) return this.chapter(request);
      const no = /Write now — Chapter (\d+)/u.exec(request.user)?.[1] ?? '?';
      const text = `Chương ${no}: Tiêu đề\n\n${'Lâm Phong rút kiếm, gió núi thổi lạnh. '.repeat(20)}\n\n\n\nHết chương ${no}.`;
      request.onText?.(text);
      return { content: text, finishReason: 'stop', usage };
    }
    if (request.system.includes('design the story bible')) return json(BIBLE);
    if (request.system.includes('into story arcs')) {
      // Overlapping and short of the end: the server tiles them.
      return json({
        arcs: [
          { title: 'Khởi đầu', summary: 'Nhặt kiếm', from_chapter: 1, to_chapter: 12 },
          { title: 'Tông môn', summary: 'Đại hội', from_chapter: 10, to_chapter: 15 },
        ],
      });
    }
    if (request.system.includes('chapter-by-chapter outline')) {
      const [, from, to] = /Return exactly chapters (\d+) to (\d+)/u.exec(request.system) ?? [];
      const chapters = [];
      for (let no = Number(from); no <= Number(to); no += 1) {
        chapters.push({
          no,
          title: `Chương ${String(no)} AI`,
          beats: [`Sự kiện ${String(no)}a`, `Sự kiện ${String(no)}b`],
        });
      }
      return json({ chapters });
    }
    if (request.system.includes('Rewrite the outline of one chapter')) {
      return json({ title: 'Viết lại', beats: ['Nhịp mới 1', 'Nhịp mới 2'] });
    }
    throw new Error(`unexpected prompt: ${request.system.slice(0, 80)}`);
  }
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
    .values({ id: adminId, email: `novel-gen-${randomUUID()}@test.local`, role })
    .execute();
  return adminId;
}

async function runId(projectId: string): Promise<string> {
  const row = await db
    .selectFrom('novel_gen_projects')
    .select('run_id')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
  return row.run_id;
}

// Runs the queued task the way the worker would, chapter after chapter for a writing run.
async function drain(projectId: string): Promise<void> {
  for (let step = 0; step < 50; step += 1) {
    const row = await db
      .selectFrom('novel_gen_projects')
      .select(['status', 'run_id'])
      .where('id', '=', projectId)
      .executeTakeFirstOrThrow();
    if (row.status !== 'queued' && row.status !== 'running') return;
    await processGenJob(projectId, row.run_id);
  }
  throw new Error('generation did not settle');
}

describe('AI novel generation (AI Studio)', () => {
  let app: FastifyInstance;
  let editor: string;
  let analyst: string;
  let llm: FakeLlm;
  let categoryId: string;

  function call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    admin = editor,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method,
      url,
      headers: adminHeaders(admin, method !== 'GET'),
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  }

  async function project(id: string): Promise<Project> {
    const res = await call('GET', `/admin/novel-gen/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json<Project>();
  }

  // Idea → bible → outline, ready to write.
  async function plannedProject(chapterCount = 4): Promise<Project> {
    const created = await call('POST', '/admin/novel-gen', {
      idea: 'Một thiếu niên phế vật nhặt được thanh kiếm gãy có linh hồn kiếm tiên.',
      category_ids: [categoryId],
      chapter_count: chapterCount,
      words_per_chapter: 800,
      auto_cover: false,
    });
    expect(created.statusCode).toBe(202);
    const id = created.json<Project>().id;
    await drain(id);
    expect((await call('POST', `/admin/novel-gen/${id}/outline/generate`, {})).statusCode).toBe(
      202,
    );
    await drain(id);
    return project(id);
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    editor = await createAdminUser('editor');
    analyst = await createAdminUser('analyst');
    categoryId = uuidv7();
    await db
      .insertInto('novel_categories')
      .values({ id: categoryId, slug: `tien-hiep-${randomUUID()}`, name: 'Tiên hiệp' })
      .execute();
  });

  beforeEach(() => {
    llm = new FakeLlm();
    setNovelGenLlm(llm);
  });

  afterAll(async () => {
    setNovelGenLlm(null);
    await app.close();
  });

  it('drafts a story bible from an idea', async () => {
    const created = await call('POST', '/admin/novel-gen', {
      idea: 'Một thiếu niên phế vật nhặt được thanh kiếm gãy có linh hồn kiếm tiên.',
      category_ids: [categoryId],
      tone: 'hài hước',
    });
    expect(created.statusCode).toBe(202);
    const queued = created.json<Project>();
    expect(queued).toMatchObject({ status: 'queued', task: 'bible', busy: true, bible: null });
    expect(queued.input.genres).toEqual(['Tiên hiệp']);

    // A second task while one is queued would double the spend.
    expect(
      (await call('POST', `/admin/novel-gen/${queued.id}/bible/regenerate`, {})).statusCode,
    ).toBe(409);

    await drain(queued.id);
    const done = await project(queued.id);
    expect(done).toMatchObject({ status: 'idle', busy: false, title: BIBLE.title });
    expect(done.bible?.characters.map((c) => c.name)).toEqual(['Lâm Phong', 'Tô Nguyệt']);
    expect(done.prompt_tokens).toBe(100);
    expect(llm.calls[0]?.user).toContain('Genres: Tiên hiệp');
    expect(llm.calls[0]?.user).toContain('Tone: hài hước');

    // Regenerating sends the current bible and the editor's note.
    await call('POST', `/admin/novel-gen/${queued.id}/bible/regenerate`, {
      note: 'Đổi tên nữ chính',
    });
    await drain(queued.id);
    expect(llm.calls[1]?.user).toContain('Đổi tên nữ chính');
    expect(llm.calls[1]?.user).toContain('Current bible');

    const list = await call('GET', '/admin/novel-gen');
    expect(
      list.json<{ items: { id: string }[] }>().items.some((item) => item.id === queued.id),
    ).toBe(true);
  });

  it('saves an edited bible and rejects one without a title', async () => {
    const { id, bible } = await plannedProject();
    const edited = await call('PUT', `/admin/novel-gen/${id}/bible`, {
      bible: { ...bible, title: '  Kiếm Tôn  ', tags: ['a', 'b'] },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json<Project>().bible).toMatchObject({ title: 'Kiếm Tôn', tags: ['a', 'b'] });
    expect(
      (await call('PUT', `/admin/novel-gen/${id}/bible`, { bible: { ...bible, title: ' ' } }))
        .statusCode,
    ).toBe(400);
  });

  it('outlines in batches, tiles the arcs and keeps locked chapters', async () => {
    const planned = await plannedProject(20);
    const outline = planned.outline;
    expect(outline?.chapters.map((c) => c.no)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // 20 chapters = one call for the arcs and two outline batches (15 + 5).
    const outlineCalls = llm.calls.filter((c) => c.system.includes('chapter-by-chapter outline'));
    expect(outlineCalls).toHaveLength(2);
    expect(outlineCalls[1]?.user).toContain('Outline so far');
    expect(outline?.arcs.map((a) => [a.from_chapter, a.to_chapter])).toEqual([
      [1, 12],
      [13, 20],
    ]);

    // Lock chapter 3 with an edit, then regenerate the whole outline.
    const chapters = outline?.chapters.map((c) =>
      c.no === 3 ? { ...c, title: 'Do biên tập viết', locked: true } : c,
    );
    expect(
      (
        await call('PUT', `/admin/novel-gen/${planned.id}/outline`, {
          outline: { ...outline, chapters },
        })
      ).statusCode,
    ).toBe(200);
    await call('POST', `/admin/novel-gen/${planned.id}/outline/generate`, {
      note: 'Thêm phản diện',
    });
    await drain(planned.id);
    const regenerated = await project(planned.id);
    expect(regenerated.outline?.chapters[2]).toMatchObject({
      title: 'Do biên tập viết',
      locked: true,
    });
    expect(regenerated.outline?.chapters[3]?.title).toBe('Chương 4 AI');
    expect(llm.calls.at(-2)?.user).toContain('Do biên tập viết');

    // A locked chapter can't be regenerated on its own; an unlocked one can.
    expect(
      (await call('POST', `/admin/novel-gen/${planned.id}/outline/chapters/3/regenerate`, {}))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call('POST', `/admin/novel-gen/${planned.id}/outline/chapters/5/regenerate`, {
          note: 'kịch tính hơn',
        })
      ).statusCode,
    ).toBe(202);
    await drain(planned.id);
    const single = await project(planned.id);
    expect(single.outline?.chapters[4]).toMatchObject({
      no: 5,
      title: 'Viết lại',
      beats: ['Nhịp mới 1', 'Nhịp mới 2'],
    });
    expect(single.outline?.chapters[5]?.title).toBe('Chương 6 AI');
  });

  it('renumbers an edited outline in array order', async () => {
    const planned = await plannedProject(4);
    const chapters = [...(planned.outline?.chapters ?? [])].reverse();
    const saved = await call('PUT', `/admin/novel-gen/${planned.id}/outline`, {
      outline: { arcs: planned.outline?.arcs, chapters: chapters.slice(0, 3) },
    });
    const outline = saved.json<Project>().outline;
    expect(outline?.chapters.map((c) => [c.no, c.title])).toEqual([
      [1, 'Chương 4 AI'],
      [2, 'Chương 3 AI'],
      [3, 'Chương 2 AI'],
    ]);
    expect(saved.json<Project>().input.chapter_count).toBe(3);
  });

  it('writes the chapters as drafts of a new AI-generated novel', async () => {
    const planned = await plannedProject(4);
    const started = await call('POST', `/admin/novel-gen/${planned.id}/write`, {});
    expect(started.statusCode).toBe(202);
    const novelId = started.json<Project>().novel_id;
    expect(novelId).not.toBeNull();

    const novel = await db
      .selectFrom('novels')
      .selectAll()
      .where('id', '=', novelId ?? '')
      .executeTakeFirstOrThrow();
    expect(novel).toMatchObject({
      title: BIBLE.title,
      status: 'draft',
      ai_generated: true,
      editor_reviewed: false,
    });
    expect(novel.description).toBe(BIBLE.description);
    const links = await db
      .selectFrom('novel_category_links')
      .select('category_id')
      .where('novel_id', '=', novel.id)
      .execute();
    expect(links.map((link) => link.category_id)).toEqual([categoryId]);

    await drain(planned.id);
    const done = await project(planned.id);
    expect(done).toMatchObject({ status: 'idle', write_next: 5, live_text: null, errors: [] });
    expect(done.written.map((c) => [c.chapter_no, c.status])).toEqual([
      [1, 'draft'],
      [2, 'draft'],
      [3, 'draft'],
      [4, 'draft'],
    ]);

    const chapters = await db
      .selectFrom('novel_chapters')
      .select(['chapter_no', 'title', 'content'])
      .where('novel_id', '=', novel.id)
      .orderBy('chapter_no')
      .execute();
    // The heading the model added is stripped; the outline title is the chapter title.
    expect(chapters[0]?.title).toBe('Chương 1 AI');
    expect(chapters[0]?.content.startsWith('Lâm Phong rút kiếm')).toBe(true);
    expect(chapters[0]?.content).not.toContain('\n\n\n');

    // Chapter 2's prompt carries the end of chapter 1 and chapter 3's plan as setup only.
    const second = llm.calls.filter((c) => c.kind === 'chapter')[1];
    expect(second?.user).toContain('End of the previous chapter');
    expect(second?.user).toContain('Next chapter, for setup only');
    expect(second?.system).toContain('About 800 words');

    // Nothing left to write unless overwriting.
    expect((await call('POST', `/admin/novel-gen/${planned.id}/write`, {})).statusCode).toBe(409);
    // Overwrite keeps the previous text as a revision.
    expect(
      (
        await call('POST', `/admin/novel-gen/${planned.id}/write`, {
          from: 2,
          to: 2,
          overwrite: true,
        })
      ).statusCode,
    ).toBe(202);
    await drain(planned.id);
    const revisions = await db
      .selectFrom('novel_chapter_revisions')
      .innerJoin('novel_chapters', 'novel_chapters.id', 'novel_chapter_revisions.chapter_id')
      .select('novel_chapters.chapter_no')
      .where('novel_chapters.novel_id', '=', novel.id)
      .execute();
    expect(revisions.map((r) => r.chapter_no)).toEqual([2]);
    // Still one novel for the project.
    expect((await project(planned.id)).novel_id).toBe(novelId);
  });

  it('pauses a writing run mid-chapter and resumes where it stopped', async () => {
    const planned = await plannedProject(3);
    let release: (() => void) | null = null;
    llm.chapter = (request) =>
      new Promise<ChatResult>((resolve, reject) => {
        request.onText?.('Đoạn đầu đang viết…');
        request.signal?.addEventListener('abort', () => {
          reject(new AppError('NOVEL_GEN_ABORTED', 'Stopped', 499));
        });
        release = () => {
          resolve({ content: 'Văn bản chương. '.repeat(30), finishReason: 'stop', usage });
        };
      });
    await call('POST', `/admin/novel-gen/${planned.id}/write`, {});
    const running = processGenJob(planned.id, await runId(planned.id));

    // The heartbeat publishes the streamed text for the CMS.
    await expect
      .poll(async () => (await project(planned.id)).live_text, { timeout: 5000 })
      .toBe('Đoạn đầu đang viết…');
    const stopped = await call('POST', `/admin/novel-gen/${planned.id}/stop`);
    expect(stopped.json<Project>()).toMatchObject({ status: 'paused', live_text: null });
    // The next heartbeat sees the stop and aborts the call; nothing is saved.
    await running;
    expect(release).not.toBeNull();
    const paused = await project(planned.id);
    expect(paused).toMatchObject({ status: 'paused', written: [], errors: [] });

    llm.chapter = null;
    expect((await call('POST', `/admin/novel-gen/${planned.id}/write`, {})).statusCode).toBe(202);
    await drain(planned.id);
    expect((await project(planned.id)).written.map((c) => c.chapter_no)).toEqual([1, 2, 3]);
  }, 15_000);

  it('records a failed chapter and keeps what was written', async () => {
    const planned = await plannedProject(3);
    let calls = 0;
    llm.chapter = (request) => {
      calls += 1;
      if (calls === 2) return Promise.resolve({ content: 'quá ngắn', finishReason: 'stop', usage });
      const text = 'Một đoạn văn đủ dài để làm chương truyện. '.repeat(10);
      request.onText?.(text);
      return Promise.resolve({ content: text, finishReason: 'stop', usage });
    };
    await call('POST', `/admin/novel-gen/${planned.id}/write`, {});
    await drain(planned.id);
    const failed = await project(planned.id);
    expect(failed.status).toBe('failed');
    expect(failed.errors[0]).toContain('chapter 2');
    expect(failed.written.map((c) => c.chapter_no)).toEqual([1]);
  });

  // The 503 without a key lives in ai-settings.test.ts: the key is shared database state.
  it('is for editors only', async () => {
    expect((await call('GET', '/admin/novel-gen', undefined, analyst)).statusCode).toBe(403);
  });
});
