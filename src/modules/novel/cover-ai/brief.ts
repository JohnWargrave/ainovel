import { env } from '../../../config/env.js';
import { AppError } from '../../../lib/errors.js';

// What the art director step (DeepSeek) hands the image model. English, because FLUX follows English prompts
// far better than Vietnamese; `prompt` is the only field FLUX sees, the rest is for the admin
// reading (and editing) the brief in the CMS.
export interface CoverBrief {
  subject: string;
  setting: string;
  mood: string;
  palette: string;
  style: string;
  composition: string;
  prompt: string;
}

export interface CoverBriefInput {
  title: string;
  author: string | null;
  description: string | null;
  genres: string[];
  tags: string[];
  excerpt: string;
}

export interface CoverBriefWriter {
  write(input: CoverBriefInput): Promise<CoverBrief>;
}

const BRIEF_FIELDS = [
  'subject',
  'setting',
  'mood',
  'palette',
  'style',
  'composition',
  'prompt',
] as const;

const SYSTEM = `You are the art director for a web-novel reading app. From a novel's metadata and opening chapters, write a brief for ONE portrait book-cover illustration (2:3) that a text-to-image model will render.

Rules for the illustration:
- No text of any kind: no letters, titles, signatures, watermarks or logos. The title is added later.
- Keep the lower third calm and uncluttered (sky, mist, ground, shadow) so a title can sit there.
- One clear focal subject drawn from the story itself (a character, place or moment from the opening), not a generic genre scene.
- Match the art style to the genre: xianxia/wuxia → Chinese ink-and-color fantasy painting; romance → soft cinematic illustration; horror → dark atmospheric painting; urban/modern → cinematic digital art; sci-fi → detailed concept art; otherwise choose what a bestselling cover in that genre would use.
- Nothing sexual or suggestive, no gore, no real people or celebrities, no brands, no copyrighted characters. Characters are adults.

Answer with a single JSON object and nothing else, every value an English string, in this shape:
{"subject": "...", "setting": "...", "mood": "...", "palette": "...", "style": "...", "composition": "...", "prompt": "..."}
"prompt" is the full text-to-image prompt (60–120 words): subject, setting, lighting, palette, style and composition in one paragraph, ending with "no text, no lettering".`;

// Enough of the opening to find the protagonist and the first set piece; covers don't need more.
export const EXCERPT_CHARS = 6000;

// Streamed so a model that is merely slow (it sends `: keep-alive` lines while queued) can be told
// apart from one that is down, and so the wait is bounded by our clock rather than DeepSeek's.
// Under load DeepSeek has been seen holding requests for minutes before the first token.
const FIRST_TOKEN_TIMEOUT_MS = 90_000;
const TOTAL_TIMEOUT_MS = 180_000;

interface StreamChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  error?: { message?: string };
}

interface StreamResult {
  content: string;
  finishReason: string | null;
}

function parseBrief(content: string | null | undefined): CoverBrief | null {
  if (!content) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record['prompt'] !== 'string' || record['prompt'].trim() === '') return null;
  return Object.fromEntries(
    BRIEF_FIELDS.map((field) => [field, typeof record[field] === 'string' ? record[field] : '']),
  ) as unknown as CoverBrief;
}

function novelText(input: CoverBriefInput): string {
  return [
    `Title: ${input.title}`,
    input.author ? `Author: ${input.author}` : null,
    input.genres.length > 0 ? `Genres: ${input.genres.join(', ')}` : null,
    input.tags.length > 0 ? `Tags: ${input.tags.join(', ')}` : null,
    input.description ? `Description:\n${input.description}` : null,
    input.excerpt ? `Opening chapters (excerpt):\n${input.excerpt}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n\n');
}

// DeepSeek's OpenAI-compatible chat API in JSON mode, streamed. Thinking is off: the brief is a
// short creative rewrite, and reasoning would only add latency and tokens.
class DeepSeekCoverBriefWriter implements CoverBriefWriter {
  constructor(private readonly apiKey: string) {}

  private async complete(novel: string): Promise<StreamResult> {
    const controller = new AbortController();
    // An object, not a `let`: TypeScript can't see the timer callbacks assign it.
    const timeout: { reason: 'first_token' | 'total' | null } = { reason: null };
    const abort = (reason: 'first_token' | 'total'): void => {
      timeout.reason = reason;
      controller.abort();
    };
    const firstTokenTimer = setTimeout(() => {
      abort('first_token');
    }, FIRST_TOKEN_TIMEOUT_MS);
    const totalTimer = setTimeout(() => {
      abort('total');
    }, TOTAL_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${env.DEEPSEEK_BASE_URL.replace(/\/+$/u, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: env.COVER_AI_BRIEF_MODEL,
            stream: true,
            thinking: { type: 'disabled' },
            response_format: { type: 'json_object' },
            max_tokens: 1500,
            messages: [
              { role: 'system', content: SYSTEM },
              {
                role: 'user',
                content: `<novel>\n${novel}\n</novel>\n\nReturn the cover brief as JSON.`,
              },
            ],
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => ({}))) as StreamChunk;
        throw new AppError(
          'COVER_AI_BRIEF_FAILED',
          `DeepSeek answered HTTP ${String(response.status)}; the cover prompt could not be written`,
          502,
          { status: response.status, error: body.error?.message },
        );
      }

      let content = '';
      let finishReason: string | null = null;
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
          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) {
            clearTimeout(firstTokenTimer);
            content += choice.delta.content;
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        }
      }
      return { content, finishReason };
    } catch (err) {
      if (timeout.reason) {
        throw new AppError(
          'COVER_AI_BRIEF_TIMEOUT',
          timeout.reason === 'first_token'
            ? `DeepSeek did not start answering within ${String(FIRST_TOKEN_TIMEOUT_MS / 1000)}s (it is probably overloaded)`
            : `DeepSeek did not finish within ${String(TOTAL_TIMEOUT_MS / 1000)}s`,
          504,
        );
      }
      if (err instanceof AppError) throw err;
      throw new AppError('COVER_AI_BRIEF_FAILED', 'Could not reach DeepSeek', 502, {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(firstTokenTimer);
      clearTimeout(totalTimer);
    }
  }

  async write(input: CoverBriefInput): Promise<CoverBrief> {
    const novel = novelText(input);
    // JSON mode occasionally answers with empty content (a known DeepSeek issue); one retry covers
    // it. Timeouts and HTTP errors are not retried: they would only double the wait.
    let finishReason: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.complete(novel);
      if (result.finishReason === 'content_filter') {
        throw new AppError(
          'COVER_AI_BRIEF_REFUSED',
          'DeepSeek declined to write a cover prompt for this novel; write the prompt by hand',
          422,
        );
      }
      const brief = parseBrief(result.content);
      if (brief) return brief;
      finishReason = result.finishReason;
    }
    throw new AppError('COVER_AI_BRIEF_FAILED', 'DeepSeek returned no usable cover prompt', 502, {
      finish_reason: finishReason,
    });
  }
}

// Used when DeepSeek is down or slow, so a click still yields covers. It cannot read Vietnamese
// text into an English scene, so it leans on the genre for style and keeps the subject generic;
// the admin can always write a better prompt by hand.
const GENRE_STYLES: { match: RegExp; scene: string; style: string }[] = [
  {
    match: /tiên hiệp|tu tiên|huyền huyễn|xianxia|cultivation|kiếm hiệp|võ hiệp|wuxia/iu,
    scene: 'a lone cultivator in flowing robes on a misty mountain peak above a sea of clouds',
    style: 'Chinese ink-and-color fantasy painting, jade and gold palette',
  },
  {
    match: /ngôn tình|lãng mạn|romance|tình cảm|đam mỹ|bách hợp/iu,
    scene: 'a young woman in a sunlit old city street, a quiet moment of longing',
    style: 'soft cinematic romance illustration, warm pastel light',
  },
  {
    match: /kinh dị|horror|linh dị|ma/iu,
    scene: 'a dark abandoned house at the end of a foggy road, a single lit window',
    style: 'dark atmospheric painting, cold desaturated palette, deep shadows',
  },
  {
    match: /trinh thám|hình sự|mystery|detective|thriller/iu,
    scene: 'a figure in a long coat under a streetlight on a rain-soaked night street',
    style: 'noir cinematic digital art, teal and amber palette',
  },
  {
    match: /khoa huyễn|khoa học viễn tưởng|sci-?fi|mạt thế|tương lai/iu,
    scene: 'a lone explorer facing a vast futuristic city skyline under twin moons',
    style: 'detailed sci-fi concept art, neon blue and violet palette',
  },
  {
    match: /lịch sử|cổ đại|cung đấu|historical|quân sự/iu,
    scene: 'an ancient palace courtyard at dusk with red lanterns and a solitary figure',
    style: 'historical epic painting, crimson and gold palette',
  },
  {
    match: /đô thị|hiện đại|urban|học đường|thanh xuân/iu,
    scene: 'a young person on a rooftop overlooking a glowing modern city at golden hour',
    style: 'cinematic contemporary digital art, warm golden light',
  },
];

export function fallbackBrief(input: CoverBriefInput): CoverBrief {
  const haystack = [...input.genres, ...input.tags].join(' ');
  const genre = GENRE_STYLES.find((entry) => entry.match.test(haystack));
  const scene = genre?.scene ?? 'a solitary figure in an evocative landscape at golden hour';
  const style =
    genre?.style ?? 'painterly cinematic book-cover illustration, rich atmospheric light';
  return {
    subject: scene,
    setting: '',
    mood: 'evocative',
    palette: '',
    style,
    composition: 'subject in the upper two thirds, calm shadowed lower third',
    prompt: `Book cover illustration: ${scene}. ${style}, highly detailed, dramatic atmospheric lighting, subject in the upper two thirds, calm uncluttered darker lower third, no text, no lettering`,
  };
}

let override: CoverBriefWriter | null = null;
let configured: CoverBriefWriter | null = null;

export function setCoverBriefWriter(writer: CoverBriefWriter | null): void {
  override = writer;
}

export function getCoverBriefWriter(): CoverBriefWriter {
  if (override) return override;
  if (!env.DEEPSEEK_API_KEY) {
    throw new AppError('COVER_AI_NOT_CONFIGURED', 'AI cover generation is not configured', 503);
  }
  configured ??= new DeepSeekCoverBriefWriter(env.DEEPSEEK_API_KEY);
  return configured;
}

// A brief the admin typed in the CMS: free text becomes the prompt as-is.
export function manualBrief(prompt: string): CoverBrief {
  return {
    subject: '',
    setting: '',
    mood: '',
    palette: '',
    style: '',
    composition: '',
    prompt,
  };
}
