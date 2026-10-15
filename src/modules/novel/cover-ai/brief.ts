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

interface ChatCompletion {
  choices?: { finish_reason?: string; message?: { content?: string | null } }[];
  error?: { message?: string };
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

// DeepSeek's OpenAI-compatible chat API in JSON mode. Thinking is off: the brief is a short
// creative rewrite, and reasoning would only add latency and tokens.
class DeepSeekCoverBriefWriter implements CoverBriefWriter {
  constructor(private readonly apiKey: string) {}

  async write(input: CoverBriefInput): Promise<CoverBrief> {
    const novel = [
      `Title: ${input.title}`,
      input.author ? `Author: ${input.author}` : null,
      input.genres.length > 0 ? `Genres: ${input.genres.join(', ')}` : null,
      input.tags.length > 0 ? `Tags: ${input.tags.join(', ')}` : null,
      input.description ? `Description:\n${input.description}` : null,
      input.excerpt ? `Opening chapters (excerpt):\n${input.excerpt}` : null,
    ]
      .filter((line) => line !== null)
      .join('\n\n');

    // JSON mode occasionally answers with empty content (a known DeepSeek issue); one retry
    // covers it without making a real outage wait twice as long.
    let lastFailure: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
          signal: AbortSignal.timeout(60_000),
        },
      );
      const body = (await response.json().catch(() => ({}))) as ChatCompletion;
      const choice = body.choices?.[0];
      if (choice?.finish_reason === 'content_filter') {
        throw new AppError(
          'COVER_AI_BRIEF_REFUSED',
          'The model declined to write a cover brief for this novel; write the prompt by hand',
          422,
        );
      }
      const brief = response.ok ? parseBrief(choice?.message?.content) : null;
      if (brief) return brief;
      lastFailure = {
        status: response.status,
        finish_reason: choice?.finish_reason,
        error: body.error?.message,
      };
      // Auth, quota and bad-request errors won't fix themselves on a retry.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
    }
    throw new AppError(
      'COVER_AI_BRIEF_FAILED',
      'The cover brief could not be written',
      502,
      lastFailure,
    );
  }
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
