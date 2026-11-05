import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { env } from '../../../config/env.js';
import { db } from '../../../db/index.js';
import { AppError } from '../../../lib/errors.js';
import type { ChatUsage } from './deepseek-chat.js';

// DeepSeek settings from the CMS (ai_settings), merged over the environment. Callers that are
// already async load the row first (loadAiSettings); the merge itself is synchronous so the cover
// brief writer and the "is it configured" checks can stay sync.

export interface AiModel {
  id: string;
  label: string;
  // USD per 1M tokens.
  input_cache_hit: number;
  input_cache_miss: number;
  output: number;
}

export interface AiConfig {
  apiKey: string | null;
  keySource: 'cms' | 'env' | null;
  keyHint: string | null;
  baseUrl: string;
  novelModel: string;
  coverModel: string;
  models: AiModel[];
}

interface StoredSettings {
  apiKey: string | null;
  keyUnreadable: boolean;
  keyHint: string | null;
  baseUrl: string | null;
  novelModel: string | null;
  coverModel: string | null;
  models: AiModel[];
  updatedAt: string | null;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
// The row as last loaded in this process.
let stored: StoredSettings | null = null;

function readModels(value: unknown): AiModel[] {
  if (!Array.isArray(value)) return [];
  const price = (raw: unknown): number => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };
  return value
    .map((entry): AiModel | null => {
      const model = entry as Record<string, unknown> | null;
      const id = typeof model?.['id'] === 'string' ? model['id'].trim() : '';
      if (!id) return null;
      return {
        id,
        label: typeof model?.['label'] === 'string' ? model['label'].trim() : '',
        input_cache_hit: price(model?.['input_cache_hit']),
        input_cache_miss: price(model?.['input_cache_miss']),
        output: price(model?.['output']),
      };
    })
    .filter((model) => model !== null);
}

// Reads the row and decrypts the key. Not cached: every AI task starts with it, it is one small
// query next to a call that takes seconds, and a key saved in the CMS (by the API process) must
// apply to the very next job in the worker.
export async function loadAiSettings(): Promise<AiConfig> {
  const row = await db
    .selectFrom('ai_settings')
    .select([
      'key_hint',
      'deepseek_base_url',
      'novel_model',
      'cover_model',
      'models',
      'updated_at',
      'deepseek_api_key',
    ])
    .where('id', '=', 1)
    .executeTakeFirst();
  const decrypted = row?.deepseek_api_key ? await decryptKey(row.deepseek_api_key) : null;
  stored = {
    apiKey: decrypted ?? null,
    // Saved under another DELIVERY_CODE_ENC_KEY (rotated, or another environment's database): the
    // key is unusable until a superadmin enters it again, but the settings still load.
    keyUnreadable: Boolean(row?.deepseek_api_key) && decrypted === null,
    keyHint: row?.key_hint ?? null,
    baseUrl: row?.deepseek_base_url ?? null,
    novelModel: row?.novel_model ?? null,
    coverModel: row?.cover_model ?? null,
    models: readModels(row?.models),
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
  };
  return aiConfig();
}

async function decryptKey(encrypted: string): Promise<string | null> {
  try {
    const result = await db
      .selectNoFrom(
        sql<string>`pgp_sym_decrypt(decode(${encrypted}, 'base64'), ${env.DELIVERY_CODE_ENC_KEY})`.as(
          'value',
        ),
      )
      .executeTakeFirstOrThrow();
    return result.value;
  } catch {
    return null;
  }
}

// The current settings: the last loaded row, else the environment alone.
export function aiConfig(): AiConfig {
  const cmsKey = stored?.apiKey ?? null;
  const envKey = env.DEEPSEEK_API_KEY ?? null;
  const coverModel = stored?.coverModel ?? env.COVER_AI_BRIEF_MODEL;
  const novelModel = stored?.novelModel ?? env.NOVEL_GEN_MODEL ?? coverModel;
  const models = [...(stored?.models ?? [])];
  // The models in use are always on the list, priced at zero until someone enters a price.
  for (const id of [novelModel, coverModel]) {
    if (!models.some((model) => model.id === id)) {
      models.push({ id, label: '', input_cache_hit: 0, input_cache_miss: 0, output: 0 });
    }
  }
  return {
    apiKey: cmsKey ?? envKey,
    keySource: cmsKey ? 'cms' : envKey ? 'env' : null,
    keyHint: cmsKey ? (stored?.keyHint ?? null) : envKey ? envKey.slice(-4) : null,
    baseUrl: (stored?.baseUrl ?? env.DEEPSEEK_BASE_URL) || DEFAULT_BASE_URL,
    novelModel,
    coverModel,
    models,
  };
}

// Test hook: forget the loaded row (back to the environment alone until the next load).
export function resetAiSettingsCache(): void {
  stored = null;
}

export function costUsd(config: AiConfig, modelId: string, usage: ChatUsage): number {
  const model = config.models.find((entry) => entry.id === modelId);
  if (!model) return 0;
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, usage.prompt_tokens - hit);
  return (
    (hit * model.input_cache_hit +
      miss * model.input_cache_miss +
      usage.completion_tokens * model.output) /
    1_000_000
  );
}

export function assertKnownModel(config: AiConfig, modelId: string): void {
  if (!config.models.some((model) => model.id === modelId)) {
    throw new AppError('AI_UNKNOWN_MODEL', `Model ${modelId} is not in the AI settings`, 400);
  }
}

// ---------------------------------------------------------------------------------------------
// CMS
// ---------------------------------------------------------------------------------------------

export interface PublicAiSettings {
  has_key: boolean;
  // A key is saved but can't be decrypted with this server's DELIVERY_CODE_ENC_KEY.
  key_unreadable: boolean;
  key_source: 'cms' | 'env' | null;
  // Last 4 characters, for superadmins only.
  key_hint: string | null;
  base_url: string;
  novel_model: string;
  cover_model: string;
  models: AiModel[];
  updated_at: string | null;
}

export async function getPublicAiSettings(showHint: boolean): Promise<PublicAiSettings> {
  const config = await loadAiSettings();
  return {
    has_key: config.apiKey !== null,
    key_unreadable: stored?.keyUnreadable ?? false,
    key_source: config.keySource,
    key_hint: showHint ? config.keyHint : null,
    base_url: config.baseUrl,
    novel_model: config.novelModel,
    cover_model: config.coverModel,
    models: config.models,
    updated_at: stored?.updatedAt ?? null,
  };
}

export interface UpdateAiSettingsInput {
  // Omitted keeps the saved key; null removes it (the environment key applies again).
  api_key?: string | null;
  base_url?: string | null;
  novel_model?: string | null;
  cover_model?: string | null;
  models?: AiModel[];
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

// The key is sent wherever base_url points, so only HTTPS (or a local mock in development).
function checkBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('AI_INVALID_BASE_URL', 'Base URL is not a valid URL', 400);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && env.NODE_ENV !== 'production')) {
    throw new AppError('AI_INVALID_BASE_URL', 'Base URL must use https://', 400);
  }
  return value.replace(/\/+$/u, '');
}

export async function updateAiSettings(
  input: UpdateAiSettingsInput,
  actor: { id: string },
  ip: string,
): Promise<PublicAiSettings> {
  const models = input.models !== undefined ? readModels(input.models) : undefined;
  if (models && new Set(models.map((model) => model.id)).size !== models.length) {
    throw new AppError('AI_DUPLICATE_MODEL', 'Each model can be listed once', 400);
  }
  // Defaults chosen in the CMS must stay on the list, or they would lose their prices. (Defaults
  // left to the environment are always listed.)
  if (models !== undefined) {
    await loadAiSettings();
    const chosen = [
      input.novel_model !== undefined
        ? blankToNull(input.novel_model)
        : (stored?.novelModel ?? null),
      input.cover_model !== undefined
        ? blankToNull(input.cover_model)
        : (stored?.coverModel ?? null),
    ];
    for (const id of chosen) {
      if (id && !models.some((model) => model.id === id)) {
        throw new AppError('AI_MODEL_IN_USE', `${id} is a default model; keep it on the list`, 400);
      }
    }
  }
  const apiKey = input.api_key === undefined ? undefined : (input.api_key?.trim() ?? null);
  const baseUrl =
    input.base_url === undefined
      ? undefined
      : input.base_url?.trim()
        ? checkBaseUrl(input.base_url.trim())
        : null;

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('ai_settings')
      .set({
        ...(apiKey !== undefined
          ? {
              deepseek_api_key: apiKey
                ? sql<string>`encode(pgp_sym_encrypt(${apiKey}, ${env.DELIVERY_CODE_ENC_KEY}), 'base64')`
                : null,
              key_hint: apiKey ? apiKey.slice(-4) : null,
            }
          : {}),
        ...(baseUrl !== undefined ? { deepseek_base_url: baseUrl } : {}),
        ...(input.novel_model !== undefined ? { novel_model: blankToNull(input.novel_model) } : {}),
        ...(input.cover_model !== undefined ? { cover_model: blankToNull(input.cover_model) } : {}),
        ...(models !== undefined ? { models: JSON.stringify(models) } : {}),
        updated_by: actor.id,
        updated_at: new Date(),
      })
      .where('id', '=', 1)
      .execute();
    await trx
      .insertInto('audit_log')
      .values({
        id: uuidv7(),
        admin_user_id: actor.id,
        action: 'AI_SETTINGS_UPDATED',
        target_type: 'ai_settings',
        target_id: null,
        // Never the key itself.
        detail: JSON.stringify({
          api_key: apiKey === undefined ? 'unchanged' : apiKey ? 'set' : 'removed',
          base_url: baseUrl,
          novel_model: input.novel_model,
          cover_model: input.cover_model,
          models: models?.map((model) => model.id),
        }),
        ip,
      })
      .execute();
  });

  await loadAiSettings();
  return getPublicAiSettings(true);
}

export interface AiKeyCheck {
  ok: boolean;
  error: string | null;
  models: string[];
  balance: { currency: string; total_balance: string }[] | null;
}

async function getJson(url: string, apiKey: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// Lists the account's models and balance with the given key (or the saved one).
export async function checkAiKey(input: {
  api_key?: string;
  base_url?: string;
}): Promise<AiKeyCheck> {
  const config = await loadAiSettings();
  const apiKey = blankToNull(input.api_key) ?? config.apiKey;
  if (!apiKey) return { ok: false, error: 'No API key to test', models: [], balance: null };
  const baseUrl = input.base_url?.trim() ? checkBaseUrl(input.base_url.trim()) : config.baseUrl;
  try {
    const models = await getJson(`${baseUrl}/models`, apiKey);
    if (models.status !== 200) {
      return {
        ok: false,
        error:
          models.status === 401
            ? 'DeepSeek rejected the API key'
            : `DeepSeek answered HTTP ${String(models.status)}`,
        models: [],
        balance: null,
      };
    }
    const ids = ((models.body as { data?: { id?: unknown }[] } | null)?.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === 'string');
    // Balance is a DeepSeek extra; other OpenAI-compatible hosts don't have it.
    const balance = await getJson(`${baseUrl}/user/balance`, apiKey).catch(() => null);
    const infos = (
      balance?.body as { balance_infos?: { currency?: unknown; total_balance?: unknown }[] } | null
    )?.balance_infos;
    return {
      ok: true,
      error: null,
      models: ids,
      balance: Array.isArray(infos)
        ? infos.map((info) => ({
            currency: String(info.currency),
            total_balance: String(info.total_balance),
          }))
        : null,
    };
  } catch {
    return { ok: false, error: `Could not reach ${baseUrl}`, models: [], balance: null };
  }
}
