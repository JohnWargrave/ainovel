import { AppError } from '../../../lib/errors.js';
import { streamDeepSeekChat, type ChatResult } from '../ai/deepseek-chat.js';
import { aiConfig } from '../ai/settings.js';

export interface NovelGenRequest {
  model: string;
  // 'plan' answers JSON (bible, arcs, outline batches); 'chapter' answers prose.
  kind: 'plan' | 'chapter';
  system: string;
  user: string;
  maxTokens: number;
  onText?: (text: string) => void;
  signal?: AbortSignal;
}

export interface NovelGenLlm {
  complete(request: NovelGenRequest): Promise<ChatResult>;
}

// Planning answers are a few KB of JSON; a chapter is several thousand words of prose, which at
// DeepSeek's streaming speed can take minutes.
const TIMEOUTS = {
  plan: { firstToken: 120_000, total: 300_000 },
  chapter: { firstToken: 120_000, total: 900_000 },
} as const;

// Key and host from the AI settings at call time (loadAiSettings runs before each task).
class DeepSeekNovelGenLlm implements NovelGenLlm {
  complete(request: NovelGenRequest): Promise<ChatResult> {
    const timeouts = TIMEOUTS[request.kind];
    const config = aiConfig();
    if (!config.apiKey) throw notConfigured();
    return streamDeepSeekChat(config.apiKey, {
      model: request.model,
      baseUrl: config.baseUrl,
      system: request.system,
      user: request.user,
      json: request.kind === 'plan',
      // Some variety in prose; planning stays closer to the brief.
      temperature: request.kind === 'chapter' ? 1.0 : 0.8,
      maxTokens: request.maxTokens,
      firstTokenTimeoutMs: timeouts.firstToken,
      totalTimeoutMs: timeouts.total,
      errorCode: 'NOVEL_GEN',
      failure:
        request.kind === 'chapter'
          ? 'the chapter could not be written'
          : 'the plan could not be written',
      ...(request.onText ? { onText: request.onText } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }
}

function notConfigured(): AppError {
  return new AppError(
    'NOVEL_GEN_NOT_CONFIGURED',
    'AI novel generation is not configured: add a DeepSeek API key in the AI settings',
    503,
  );
}

let override: NovelGenLlm | null = null;
const deepseek = new DeepSeekNovelGenLlm();

export function setNovelGenLlm(llm: NovelGenLlm | null): void {
  override = llm;
}

// Call loadAiSettings() first so a key saved in the CMS counts.
export function getNovelGenLlm(): NovelGenLlm {
  if (override) return override;
  if (!aiConfig().apiKey) throw notConfigured();
  return deepseek;
}
