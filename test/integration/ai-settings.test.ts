import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/app.js';
import { sql } from 'kysely';
import { db } from '../../src/db/index.js';
import type { ChatResult } from '../../src/modules/novel/ai/deepseek-chat.js';
import { setNovelGenLlm, type NovelGenRequest } from '../../src/modules/novel/generate/llm.js';
import { processGenJob } from '../../src/modules/novel/generate/service.js';

const ADMIN_API_KEY = 'test-admin-api-key';
const ADMIN_CSRF_TOKEN = 'test-admin-csrf-token';

interface Settings {
  has_key: boolean;
  key_source: string | null;
  key_hint: string | null;
  base_url: string;
  novel_model: string;
  cover_model: string;
  models: {
    id: string;
    label: string;
    input_cache_hit: number;
    input_cache_miss: number;
    output: number;
  }[];
}

async function createAdminUser(role: string): Promise<string> {
  const adminId = uuidv7();
  await db
    .insertInto('admin_users')
    .values({ id: adminId, email: `ai-settings-${randomUUID()}@test.local`, role })
    .execute();
  return adminId;
}

describe('AI settings (DeepSeek key, models and prices)', () => {
  let app: FastifyInstance;
  let superadmin: string;
  let editor: string;

  function call(
    admin: string,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method,
      url,
      headers: {
        'x-admin-api-key': ADMIN_API_KEY,
        'x-admin-user-id': admin,
        ...(method !== 'GET' ? { 'x-csrf-token': ADMIN_CSRF_TOKEN } : {}),
      },
      ...(payload ? { payload } : {}),
    });
  }

  const PRO = {
    id: 'deepseek-test-pro',
    label: 'Pro',
    input_cache_hit: 0.1,
    input_cache_miss: 1,
    output: 2,
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    superadmin = await createAdminUser('superadmin');
    editor = await createAdminUser('editor');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setNovelGenLlm(null);
  });

  afterAll(async () => {
    // Back to "use the environment" for whatever runs next.
    await call(superadmin, 'PUT', '/admin/ai-settings', {
      api_key: null,
      base_url: null,
      novel_model: null,
      models: [],
    });
    await app.close();
  });

  it('stores the key encrypted, never returns it, and lets superadmins alone change it', async () => {
    const before = (await call(editor, 'GET', '/admin/ai-settings')).json<Settings>();
    expect(before).toMatchObject({ has_key: false, key_source: null, key_hint: null });

    expect(
      (await call(editor, 'PUT', '/admin/ai-settings', { api_key: 'sk-editor-1234' })).statusCode,
    ).toBe(403);

    const saved = await call(superadmin, 'PUT', '/admin/ai-settings', {
      api_key: '  sk-test-secret-abcd  ',
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<Settings>()).toMatchObject({
      has_key: true,
      key_source: 'cms',
      key_hint: 'abcd',
    });
    expect(saved.body).not.toContain('sk-test-secret');

    const row = await db
      .selectFrom('ai_settings')
      .select('deepseek_api_key')
      .executeTakeFirstOrThrow();
    expect(row.deepseek_api_key).not.toBeNull();
    expect(row.deepseek_api_key).not.toContain('sk-test-secret');

    // Editors see that a key exists, not its hint.
    expect((await call(editor, 'GET', '/admin/ai-settings')).json<Settings>()).toMatchObject({
      has_key: true,
      key_hint: null,
    });

    const audit = await db
      .selectFrom('audit_log')
      .select('detail')
      .where('action', '=', 'AI_SETTINGS_UPDATED')
      .where('admin_user_id', '=', superadmin)
      .execute();
    expect(JSON.stringify(audit)).not.toContain('sk-test-secret');
    expect(JSON.stringify(audit)).toContain('"api_key":"set"');
  });

  it('still loads when the saved key was encrypted under another key, and takes a new one', async () => {
    await db
      .updateTable('ai_settings')
      .set({
        deepseek_api_key: sql<string>`encode(pgp_sym_encrypt('sk-elsewhere', 'another-environment-key'), 'base64')`,
        key_hint: 'here',
      })
      .where('id', '=', 1)
      .execute();
    const res = await call(superadmin, 'GET', '/admin/ai-settings');
    expect(res.statusCode).toBe(200);
    expect(res.json<Settings & { key_unreadable: boolean }>()).toMatchObject({
      key_unreadable: true,
      has_key: false,
    });
    const fixed = await call(superadmin, 'PUT', '/admin/ai-settings', { api_key: 'sk-fresh-1111' });
    expect(fixed.json<Settings & { key_unreadable: boolean }>()).toMatchObject({
      key_unreadable: false,
      has_key: true,
      key_hint: '1111',
    });
  });

  it('turns AI Studio on with the CMS key and off again when it is removed', async () => {
    await call(superadmin, 'PUT', '/admin/ai-settings', { api_key: null });
    const idea = { idea: 'Một ý tưởng đủ dài để thử cấu hình khoá API.', chapter_count: 3 };
    const off = await call(editor, 'POST', '/admin/novel-gen', idea);
    expect(off.statusCode).toBe(503);
    expect(off.json<{ error: { message: string } }>().error.message).toContain('AI settings');

    await call(superadmin, 'PUT', '/admin/ai-settings', { api_key: 'sk-test-on-9999' });
    const on = await call(editor, 'POST', '/admin/novel-gen', idea);
    expect(on.statusCode).toBe(202);
    await db
      .deleteFrom('novel_gen_projects')
      .where('id', '=', on.json<{ id: string }>().id)
      .execute();
  });

  it('prices each call with the model the project uses', async () => {
    // The cover model stays on the list (it is a default too).
    const { cover_model: coverModel } = (
      await call(superadmin, 'GET', '/admin/ai-settings')
    ).json<Settings>();
    const put = await call(superadmin, 'PUT', '/admin/ai-settings', {
      api_key: 'sk-test-price-0000',
      novel_model: PRO.id,
      models: [
        PRO,
        { ...PRO, id: 'deepseek-test-flash', label: 'Flash', output: 0.5 },
        { ...PRO, id: coverModel, label: 'Cover' },
      ],
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<Settings>().novel_model).toBe(PRO.id);

    const seen: string[] = [];
    setNovelGenLlm({
      complete(request: NovelGenRequest): Promise<ChatResult> {
        seen.push(request.model);
        return Promise.resolve({
          content: JSON.stringify({ title: 'Giá thử', characters: [] }),
          finishReason: 'stop',
          // 1M prompt tokens (400k cached) and 500k output.
          usage: {
            prompt_tokens: 1_000_000,
            completion_tokens: 500_000,
            prompt_cache_hit_tokens: 400_000,
            prompt_cache_miss_tokens: 600_000,
          },
        });
      },
    });

    // Unknown models are refused; omitted means the default.
    expect(
      (
        await call(editor, 'POST', '/admin/novel-gen', {
          idea: 'Một ý tưởng đủ dài để thử giá.',
          model: 'gpt-who',
        })
      ).statusCode,
    ).toBe(400);
    const created = await call(editor, 'POST', '/admin/novel-gen', {
      idea: 'Một ý tưởng đủ dài để thử giá.',
    });
    const project = created.json<{ id: string }>();
    const runId = await db
      .selectFrom('novel_gen_projects')
      .select(['run_id', 'model'])
      .where('id', '=', project.id)
      .executeTakeFirstOrThrow();
    expect(runId.model).toBe(PRO.id);
    await processGenJob(project.id, runId.run_id);

    const done = (await call(editor, 'GET', `/admin/novel-gen/${project.id}`)).json<{
      cost_usd: number;
      status: string;
    }>();
    expect(done.status).toBe('idle');
    expect(seen).toEqual([PRO.id]);
    // 0.4M × 0.1 + 0.6M × 1 + 0.5M × 2 = 0.04 + 0.6 + 1.0
    expect(done.cost_usd).toBeCloseTo(1.64, 6);
  });

  it('keeps the default models on the list and checks the base URL', async () => {
    const removed = await call(superadmin, 'PUT', '/admin/ai-settings', {
      novel_model: PRO.id,
      models: [{ ...PRO, id: 'something-else' }],
    });
    expect(removed.statusCode).toBe(400);
    expect(removed.json<{ error: { code: string } }>().error.code).toBe('AI_MODEL_IN_USE');

    const insecure = await call(superadmin, 'PUT', '/admin/ai-settings', {
      base_url: 'http://deepseek.example.com',
    });
    expect(insecure.statusCode).toBe(400);
    const duplicate = await call(superadmin, 'PUT', '/admin/ai-settings', {
      models: [PRO, PRO],
    });
    expect(duplicate.json<{ error: { code: string } }>().error.code).toBe('AI_DUPLICATE_MODEL');
  });

  it('checks a key against DeepSeek and reports the models and balance', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.endsWith('/models')
              ? { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }
              : { balance_infos: [{ currency: 'USD', total_balance: '12.50' }] },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(superadmin, 'POST', '/admin/ai-settings/check', {
      api_key: 'sk-typed-not-saved',
    });
    expect(res.json()).toEqual({
      ok: true,
      error: null,
      models: ['deepseek-chat', 'deepseek-reasoner'],
      balance: [{ currency: 'USD', total_balance: '12.50' }],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/models');
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer sk-typed-not-saved',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))),
    );
    const rejected = await call(superadmin, 'POST', '/admin/ai-settings/check', {
      api_key: 'sk-bad',
    });
    expect(rejected.json()).toMatchObject({ ok: false, error: 'DeepSeek rejected the API key' });
    expect((await call(editor, 'POST', '/admin/ai-settings/check', {})).statusCode).toBe(403);
  });
});
