import { env } from '../../../config/env.js';
import { AppError } from '../../../lib/errors.js';

// DeepSeek's OpenAI-compatible chat API, always streamed. Streaming lets a model that is merely
// slow (it sends `: keep-alive` lines while queued) be told apart from one that is down, bounds the
// wait by our clock rather than DeepSeek's, and lets callers show text as it arrives. Under load
// DeepSeek has been seen holding requests for minutes before the first token.

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  // DeepSeek's context cache split of prompt_tokens, priced differently.
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface ChatResult {
  content: string;
  finishReason: string | null;
  usage: ChatUsage | null;
}

export interface ChatRequest {
  model: string;
  // Defaults to DEEPSEEK_BASE_URL.
  baseUrl?: string;
  system: string;
  user: string;
  json?: boolean;
  maxTokens: number;
  temperature?: number;
  firstTokenTimeoutMs: number;
  totalTimeoutMs: number;
  // Error codes are `${errorCode}_TIMEOUT`, `${errorCode}_FAILED` and `${errorCode}_ABORTED`.
  errorCode: string;
  // Ends "DeepSeek answered HTTP 500; …", e.g. "the cover prompt could not be written".
  failure: string;
  // Called with the whole text so far on every new token.
  onText?: (text: string) => void;
  // Aborting it stops the request and throws `${errorCode}_ABORTED`.
  signal?: AbortSignal;
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: ChatUsage | null;
  error?: { message?: string };
}

export function isAbortError(err: unknown): boolean {
  return err instanceof AppError && err.code.endsWith('_ABORTED');
}

export async function streamDeepSeekChat(apiKey: string, req: ChatRequest): Promise<ChatResult> {
  const controller = new AbortController();
  // An object, not a `let`: TypeScript can't see the timer callbacks assign it.
  const stop: { reason: 'first_token' | 'total' | 'caller' | null } = { reason: null };
  const abort = (reason: 'first_token' | 'total' | 'caller'): void => {
    stop.reason ??= reason;
    controller.abort();
  };
  const firstTokenTimer = setTimeout(() => {
    abort('first_token');
  }, req.firstTokenTimeoutMs);
  const totalTimer = setTimeout(() => {
    abort('total');
  }, req.totalTimeoutMs);
  const onCallerAbort = (): void => {
    abort('caller');
  };
  if (req.signal?.aborted) abort('caller');
  req.signal?.addEventListener('abort', onCallerAbort);
  try {
    const response = await fetch(
      `${(req.baseUrl ?? env.DEEPSEEK_BASE_URL).replace(/\/+$/u, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: req.model,
          stream: true,
          stream_options: { include_usage: true },
          // Thinking is off: these are creative writing tasks, and reasoning would only add latency
          // and tokens.
          thinking: { type: 'disabled' },
          ...(req.json ? { response_format: { type: 'json_object' } } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          max_tokens: req.maxTokens,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => ({}))) as StreamChunk;
      throw new AppError(
        `${req.errorCode}_FAILED`,
        `DeepSeek answered HTTP ${String(response.status)}; ${req.failure}`,
        502,
        { status: response.status, error: body.error?.message },
      );
    }

    let content = '';
    let finishReason: string | null = null;
    let usage: ChatUsage | null = null;
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const bytes of response.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        // ": keep-alive" comments and blank separators carry nothing.
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          continue;
        }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          clearTimeout(firstTokenTimer);
          content += choice.delta.content;
          req.onText?.(content);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }
    return { content, finishReason, usage };
  } catch (err) {
    if (stop.reason === 'caller') {
      throw new AppError(`${req.errorCode}_ABORTED`, 'Stopped before DeepSeek finished', 499);
    }
    if (stop.reason) {
      throw new AppError(
        `${req.errorCode}_TIMEOUT`,
        stop.reason === 'first_token'
          ? `DeepSeek did not start answering within ${String(req.firstTokenTimeoutMs / 1000)}s (it is probably overloaded)`
          : `DeepSeek did not finish within ${String(req.totalTimeoutMs / 1000)}s`,
        504,
      );
    }
    if (err instanceof AppError) throw err;
    throw new AppError(`${req.errorCode}_FAILED`, 'Could not reach DeepSeek', 502, {
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(firstTokenTimer);
    clearTimeout(totalTimer);
    req.signal?.removeEventListener('abort', onCallerAbort);
  }
}
