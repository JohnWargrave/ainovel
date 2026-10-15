import { env } from '../../../config/env.js';
import { AppError } from '../../../lib/errors.js';

export interface CoverImageRequest {
  prompt: string;
  seed: number;
  width: number;
  height: number;
}

export interface CoverImageGenerator {
  readonly model: string;
  generate(request: CoverImageRequest): Promise<Buffer>;
}

interface WorkersAiResponse {
  success?: boolean;
  result?: { image?: string };
  errors?: { code?: number; message?: string }[];
}

// FLUX.2 on Workers AI over the REST API. FLUX.2 models take multipart form fields (width, height
// and seed included, unlike flux-1-schnell's JSON body) and answer with a base64 image.
class WorkersAiFluxGenerator implements CoverImageGenerator {
  constructor(
    private readonly accountId: string,
    private readonly token: string,
    readonly model: string,
  ) {}

  async generate(request: CoverImageRequest): Promise<Buffer> {
    const form = new FormData();
    form.append('prompt', request.prompt);
    form.append('width', String(request.width));
    form.append('height', String(request.height));
    form.append('seed', String(request.seed));

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run/${this.model}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}` },
        body: form,
        signal: AbortSignal.timeout(90_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as WorkersAiResponse;
    const image = body.result?.image;
    if (!response.ok || !image) {
      throw new AppError('COVER_AI_IMAGE_FAILED', 'The image model did not return a cover', 502, {
        status: response.status,
        errors: body.errors,
      });
    }
    return Buffer.from(image, 'base64');
  }
}

let override: CoverImageGenerator | null = null;
let configured: CoverImageGenerator | null = null;

export function setCoverImageGenerator(generator: CoverImageGenerator | null): void {
  override = generator;
}

export function getCoverImageGenerator(): CoverImageGenerator {
  if (override) return override;
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_AI_API_TOKEN) {
    throw new AppError('COVER_AI_NOT_CONFIGURED', 'AI cover generation is not configured', 503);
  }
  configured ??= new WorkersAiFluxGenerator(
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_AI_API_TOKEN,
    env.COVER_AI_IMAGE_MODEL,
  );
  return configured;
}
