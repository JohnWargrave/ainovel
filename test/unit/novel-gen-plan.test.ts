import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamDeepSeekChat } from '../../src/modules/novel/ai/deepseek-chat.js';
import {
  cleanChapterText,
  parseJsonObject,
  sanitizeArcs,
  sanitizeBible,
  sanitizeOutline,
} from '../../src/modules/novel/generate/plan.js';

describe('novel generation plan sanitizers', () => {
  it('tiles arcs over every chapter whatever the model counted', () => {
    const arcs = sanitizeArcs(
      [
        { title: 'B', summary: '', from_chapter: 8, to_chapter: 30 },
        { title: 'A', summary: '', from_chapter: 1, to_chapter: 10 },
        { title: '', from_chapter: 1, to_chapter: 2 },
      ],
      25,
    );
    expect(arcs.map((arc) => [arc.title, arc.from_chapter, arc.to_chapter])).toEqual([
      ['A', 1, 10],
      ['B', 11, 25],
    ]);
  });

  it('needs a bible title and coerces the rest', () => {
    expect(sanitizeBible({ logline: 'x' })).toBeNull();
    const bible = sanitizeBible({
      title: ' T ',
      tags: 'a, b,,c',
      characters: [{ name: 'An', role: 'protagonist' }, { role: 'nameless' }, 'junk'],
    });
    expect(bible).toMatchObject({ title: 'T', tags: ['a', 'b', 'c'], themes: [] });
    expect(bible?.characters).toEqual([
      { name: 'An', role: 'protagonist', description: '', goal: '', relationships: '' },
    ]);
  });

  it('drops empty outline chapters and renumbers the rest', () => {
    const outline = sanitizeOutline({
      arcs: [],
      chapters: [
        { no: 9, title: 'Một', beats: ['x'] },
        { no: 2, title: '', beats: [] },
        { no: 1, title: 'Hai', beats: 'a\nb', locked: true },
      ],
    });
    expect(outline?.chapters).toEqual([
      { no: 1, title: 'Một', beats: ['x'], locked: false },
      { no: 2, title: 'Hai', beats: ['a', 'b'], locked: true },
    ]);
    expect(sanitizeOutline({ chapters: [] })).toBeNull();
  });

  it('reads JSON even when the model fences it', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('[1]')).toBeNull();
    expect(parseJsonObject('nope')).toBeNull();
  });

  it('strips headings the model adds before the prose', () => {
    expect(cleanChapterText('# Chương 12: Gặp lại\n\nĐoạn một.\n\n\n\nĐoạn hai.', 'Gặp lại')).toBe(
      'Đoạn một.\n\nĐoạn hai.',
    );
    expect(cleanChapterText('**Gặp lại**\r\nĐoạn một.', 'Gặp lại')).toBe('Đoạn một.');
    expect(cleanChapterText('Chapter 3\nText', '')).toBe('Text');
    // A sentence that merely starts with the word is prose, not a heading.
    expect(cleanChapterText('Chương trình bắt đầu.', 'X')).toBe('Chương trình bắt đầu.');
  });
});

describe('streamDeepSeekChat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sse(lines: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }

  const request = {
    model: 'm',
    system: 's',
    user: 'u',
    maxTokens: 10,
    firstTokenTimeoutMs: 1000,
    totalTimeoutMs: 2000,
    errorCode: 'TEST',
    failure: 'failed',
  };

  it('joins the streamed text and reads the usage chunk', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sse([
          ': keep-alive\n\n',
          'data: {"choices":[{"delta":{"content":"Xin "}}]}\n\ndata: {"choices":[{"delta":{"content":"chào"},"finish_reason":"stop"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const seen: string[] = [];
    const result = await streamDeepSeekChat('key', {
      ...request,
      onText: (text) => seen.push(text),
    });
    expect(result).toEqual({
      content: 'Xin chào',
      finishReason: 'stop',
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    expect(seen).toEqual(['Xin ', 'Xin chào']);
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      stream_options: unknown;
      response_format?: unknown;
    };
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.response_format).toBeUndefined();
  });

  it('turns a caller abort into an _ABORTED error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      ),
    );
    const controller = new AbortController();
    const pending = streamDeepSeekChat('key', { ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'TEST_ABORTED' });
  });

  it('reports an HTTP error with the caller wording', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'x' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(streamDeepSeekChat('key', request)).rejects.toMatchObject({
      code: 'TEST_FAILED',
      message: 'DeepSeek answered HTTP 500; failed',
    });
  });
});
