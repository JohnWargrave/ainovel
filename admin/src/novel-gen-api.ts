// Client for the /admin/novel-gen endpoints (src/modules/novel/generate/routes.ts). Shapes mirror
// src/modules/novel/generate/schemas.ts.
import { api } from './api.js';

export type GenStatus = 'queued' | 'running' | 'idle' | 'paused' | 'failed';
export type GenTask = 'bible' | 'outline' | 'outline_chapter' | 'chapters';

export interface GenInput {
  idea: string;
  title: string;
  category_ids: string[];
  genres: string[];
  language: string;
  tone: string;
  audience: string;
  chapter_count: number;
  words_per_chapter: number;
  auto_cover: boolean;
}

export interface StoryCharacter {
  name: string;
  role: string;
  description: string;
  goal: string;
  relationships: string;
}

export interface StoryBible {
  title: string;
  logline: string;
  description: string;
  setting: string;
  world_rules: string;
  tone: string;
  themes: string[];
  tags: string[];
  characters: StoryCharacter[];
}

export interface StoryArc {
  title: string;
  summary: string;
  from_chapter: number;
  to_chapter: number;
}

export interface OutlineChapter {
  no: number;
  title: string;
  beats: string[];
  locked: boolean;
}

export interface StoryOutline {
  arcs: StoryArc[];
  chapters: OutlineChapter[];
}

export interface GenProjectSummary {
  id: string;
  title: string;
  status: GenStatus;
  task: GenTask;
  // Queued or running, and not stale: editing is blocked until it finishes or is stopped.
  busy: boolean;
  novel_id: string | null;
  progress: string | null;
  planned_chapters: number;
  created_at: string;
  updated_at: string;
}

export interface GenProject extends GenProjectSummary {
  input: GenInput;
  bible: StoryBible | null;
  outline: StoryOutline | null;
  task_note: string | null;
  task_chapter_no: number | null;
  write_from: number | null;
  write_to: number | null;
  write_next: number | null;
  write_overwrite: boolean;
  live_chapter_no: number | null;
  live_text: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  // USD, at the prices in the AI settings when each call was made.
  cost_usd: number;
  errors: string[];
  written: { chapter_no: number; id: string; status: string; word_count: number }[];
}

export interface CreateGenProjectInput {
  idea: string;
  title?: string;
  category_ids?: string[];
  language?: string;
  tone?: string;
  audience?: string;
  chapter_count?: number;
  words_per_chapter?: number;
  auto_cover?: boolean;
  model?: string;
}

export interface StartWritingInput {
  from?: number;
  to?: number;
  overwrite?: boolean;
  words_per_chapter?: number;
  // Switches the project's model from this run on.
  model?: string;
}

const base = '/admin/novel-gen';
const id = encodeURIComponent;

function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function listGenProjects(): Promise<{ items: GenProjectSummary[] }> {
  return api<{ items: GenProjectSummary[] }>(base);
}

export function getGenProject(projectId: string): Promise<GenProject> {
  return api<GenProject>(`${base}/${id(projectId)}`);
}

export function createGenProject(input: CreateGenProjectInput): Promise<GenProject> {
  return post<GenProject>(base, input);
}

export function deleteGenProject(projectId: string): Promise<{ deleted: boolean }> {
  return api<{ deleted: boolean }>(`${base}/${id(projectId)}`, { method: 'DELETE' });
}

export function saveGenBible(projectId: string, bible: StoryBible): Promise<GenProject> {
  return api<GenProject>(`${base}/${id(projectId)}/bible`, {
    method: 'PUT',
    body: JSON.stringify({ bible }),
  });
}

export function regenerateGenBible(projectId: string, note: string): Promise<GenProject> {
  return post<GenProject>(`${base}/${id(projectId)}/bible/regenerate`, note ? { note } : {});
}

export function saveGenOutline(projectId: string, outline: StoryOutline): Promise<GenProject> {
  return api<GenProject>(`${base}/${id(projectId)}/outline`, {
    method: 'PUT',
    body: JSON.stringify({ outline }),
  });
}

export function generateGenOutline(
  projectId: string,
  input: { note?: string; chapter_count?: number },
): Promise<GenProject> {
  return post<GenProject>(`${base}/${id(projectId)}/outline/generate`, input);
}

export function regenerateGenOutlineChapter(
  projectId: string,
  no: number,
  note: string,
): Promise<GenProject> {
  return post<GenProject>(
    `${base}/${id(projectId)}/outline/chapters/${String(no)}/regenerate`,
    note ? { note } : {},
  );
}

export function startGenWriting(projectId: string, input: StartWritingInput): Promise<GenProject> {
  return post<GenProject>(`${base}/${id(projectId)}/write`, input);
}

export function stopGenProject(projectId: string): Promise<GenProject> {
  return post<GenProject>(`${base}/${id(projectId)}/stop`);
}

// ---- AI settings (src/modules/novel/ai/routes.ts) ----

export interface AiModel {
  id: string;
  label: string;
  // USD per 1M tokens.
  input_cache_hit: number;
  input_cache_miss: number;
  output: number;
}

export interface AiSettings {
  has_key: boolean;
  // A key is saved but this server can't decrypt it (encryption key changed): enter it again.
  key_unreadable: boolean;
  // Where the key in use comes from: saved in the CMS, or the server environment.
  key_source: 'cms' | 'env' | null;
  // Last 4 characters; superadmins only.
  key_hint: string | null;
  base_url: string;
  novel_model: string;
  cover_model: string;
  models: AiModel[];
  updated_at: string | null;
}

export interface AiSettingsInput {
  // Omit to keep the saved key; null removes it.
  api_key?: string | null;
  base_url?: string | null;
  novel_model?: string;
  cover_model?: string;
  models?: AiModel[];
}

export interface AiKeyCheck {
  ok: boolean;
  error: string | null;
  models: string[];
  balance: { currency: string; total_balance: string }[] | null;
}

export function getAiSettings(): Promise<AiSettings> {
  return api<AiSettings>('/admin/ai-settings');
}

export function saveAiSettings(input: AiSettingsInput): Promise<AiSettings> {
  return api<AiSettings>('/admin/ai-settings', { method: 'PUT', body: JSON.stringify(input) });
}

// Tests the typed key (or the saved one when empty) without saving it.
export function checkAiKey(input: { api_key?: string; base_url?: string }): Promise<AiKeyCheck> {
  return post<AiKeyCheck>('/admin/ai-settings/check', input);
}
