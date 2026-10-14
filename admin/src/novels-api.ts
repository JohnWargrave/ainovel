// Client for the /admin/novel* endpoints (src/modules/novel/admin-routes.ts). Shapes mirror
// admin-schemas.ts and import/import-schemas.ts on the server.
import { api, queryString } from './api.js';

export type NovelStatus = 'draft' | 'published' | 'hidden' | 'archived';
export type CompletionStatus = 'ongoing' | 'completed' | 'hiatus';
export type ChapterStatus = 'draft' | 'published';
export type ExportFormat = 'json' | 'zip' | 'epub' | 'txt';
export type ImportMode = 'new' | 'append' | 'replace';
export type ImportFormat = 'epub' | 'txt' | 'md' | 'docx' | 'json' | 'zip';
export type ImportStatus =
  'queued' | 'parsing' | 'ready' | 'committing' | 'done' | 'failed' | 'cancelled';

export interface AdminCategory {
  id: string;
  slug: string;
  name: string;
  sort_order: number;
  is_active: boolean;
  novel_count: number;
}

export interface CategoryInput {
  name: string;
  slug?: string;
  sort_order?: number;
  is_active?: boolean;
}

export interface AdminNovel {
  id: string;
  slug: string;
  title: string;
  alt_titles: string[];
  author: string | null;
  translator: string | null;
  description: string | null;
  cover_url: string | null;
  status: NovelStatus;
  completion_status: CompletionStatus;
  language: string;
  tags: string[];
  // null = every region.
  regions: string[] | null;
  is_featured: boolean;
  featured_rank: number;
  // null = every chapter is free.
  vip_from_chapter: number | null;
  default_unlock_coin: number;
  allow_ad_unlock: boolean;
  // 0–5, null = not rated (the app hides the stars).
  rating: number | null;
  // Distinct readers who have opened a chapter. Read-only.
  read_count: number;
  ai_generated: boolean;
  editor_reviewed: boolean;
  // Published chapters readers can see; total includes drafts.
  chapter_count: number;
  total_chapter_count: number;
  word_count: number;
  category_ids: string[];
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NovelListQuery {
  q?: string;
  status?: NovelStatus;
  completion_status?: CompletionStatus;
  category_id?: string;
  language?: string;
  featured?: 'true' | 'false';
  sort?: 'updated' | 'created' | 'title';
  cursor?: string;
}

export interface NovelList {
  items: AdminNovel[];
  next_cursor: string | null;
  total: number;
}

export interface NovelInput {
  title: string;
  slug?: string;
  alt_titles: string[];
  author: string | null;
  translator: string | null;
  description: string | null;
  status: NovelStatus;
  completion_status: CompletionStatus;
  language: string;
  tags: string[];
  regions: string[] | null;
  is_featured: boolean;
  featured_rank: number;
  vip_from_chapter: number | null;
  default_unlock_coin: number;
  allow_ad_unlock: boolean;
  category_ids: string[];
  rating: number | null;
  ai_generated: boolean;
  editor_reviewed: boolean;
}

export type BulkNovelActionName =
  | 'publish'
  | 'hide'
  | 'archive'
  | 'draft'
  | 'feature'
  | 'unfeature'
  | 'add_category'
  | 'remove_category';

export interface AdminChapterSummary {
  id: string;
  novel_id: string;
  chapter_no: number;
  title: string;
  word_count: number;
  // null = inherit the novel's vip_from_chapter policy.
  is_vip: boolean | null;
  effective_vip: boolean;
  // null = the novel's default_unlock_coin.
  unlock_coin_price: number | null;
  status: ChapterStatus;
  publish_at: string | null;
  updated_at: string;
}

export interface AdminChapter extends AdminChapterSummary {
  content: string;
}

export interface ChapterList {
  items: AdminChapterSummary[];
  next_after: number | null;
}

export interface ChapterInput {
  chapter_no?: number;
  title?: string;
  content?: string;
  is_vip?: boolean | null;
  unlock_coin_price?: number | null;
  status?: ChapterStatus;
  publish_at?: string | null;
}

export type BulkChapterActionName =
  | 'publish'
  | 'draft'
  | 'set_vip'
  | 'set_free'
  | 'inherit_vip'
  | 'set_price'
  | 'schedule'
  | 'delete';

export interface ChapterRevision {
  id: string;
  title: string;
  content: string;
  edited_by: string | null;
  created_at: string;
}

export interface NovelRegionSettings {
  region_id: string;
  enabled: boolean;
  chapter_reward_coin: number;
  reading_wpm: number;
  min_read_ratio: number;
  min_read_seconds: number;
  max_read_seconds: number;
  completion_scroll_ratio: number;
  chapter_reward_daily_cap: number;
  timezone: string;
  updated_at: string;
}
export interface NovelSettingsData {
  items: NovelRegionSettings[];
}
export type NovelRegionSettingsInput = Omit<
  NovelRegionSettings,
  'region_id' | 'timezone' | 'updated_at'
>;

export interface NovelStats {
  novel_id: string;
  days: number;
  readers: number;
  chapter_reads: number;
  completions: number;
  rewarded_chapters: number;
  coin_rewarded: number;
  unlocks_coin: number;
  unlocks_ad: number;
  coin_spent: number;
  bookshelf_count: number;
  chapters: Array<{
    chapter_no: number;
    title: string;
    readers: number;
    completions: number;
    unlocks: number;
  }>;
}

export interface TopNovels {
  days: number;
  items: Array<{
    novel_id: string;
    title: string;
    readers: number;
    completions: number;
    coin_rewarded: number;
    coin_spent: number;
  }>;
}

export interface ImportPreviewNovel {
  index: number;
  title: string;
  author: string | null;
  description: string | null;
  language: string | null;
  tags: string[];
  cover_url: string | null;
  cover_key: string | null;
  chapter_count: number;
  word_count: number;
  warning_count: number;
}

export interface ImportJob {
  id: string;
  format: string;
  filename: string;
  mode: string;
  target_novel_id: string | null;
  status: ImportStatus;
  preview: { novels: ImportPreviewNovel[] } | null;
  errors: string[];
  result_novel_ids: string[];
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface ImportChapterPage {
  items: Array<{
    chapter_no: number;
    title: string;
    word_count: number;
    warnings: string[];
    excerpt: string;
  }>;
  next_after: number | null;
}

export interface CommitImportInput {
  chapter_status?: ChapterStatus;
  novels?: Array<{
    index: number;
    skip?: boolean;
    title?: string;
    author?: string | null;
    description?: string | null;
    language?: string;
    tags?: string[];
    status?: 'draft' | 'published' | 'hidden';
    category_ids?: string[];
  }>;
}

const id = encodeURIComponent;

// ---- Categories ----

export function listNovelCategories(): Promise<{ items: AdminCategory[] }> {
  return api<{ items: AdminCategory[] }>('/admin/novel-categories');
}

export function createNovelCategory(input: CategoryInput): Promise<AdminCategory> {
  return api<AdminCategory>('/admin/novel-categories', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateNovelCategory(
  categoryId: string,
  input: CategoryInput,
): Promise<AdminCategory> {
  return api<AdminCategory>(`/admin/novel-categories/${id(categoryId)}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteNovelCategory(categoryId: string): Promise<unknown> {
  return api<unknown>(`/admin/novel-categories/${id(categoryId)}`, { method: 'DELETE' });
}

// ---- Novels ----

export function listNovels(query: NovelListQuery): Promise<NovelList> {
  return api<NovelList>(`/admin/novels${queryString({ ...query, limit: 50 })}`);
}

export function getNovel(novelId: string): Promise<AdminNovel> {
  return api<AdminNovel>(`/admin/novels/${id(novelId)}`);
}

export function createNovel(input: NovelInput): Promise<AdminNovel> {
  return api<AdminNovel>('/admin/novels', { method: 'POST', body: JSON.stringify(input) });
}

// POST, not PATCH — the server mounts the update on POST /admin/novels/:id.
export function updateNovel(novelId: string, input: Partial<NovelInput>): Promise<AdminNovel> {
  return api<AdminNovel>(`/admin/novels/${id(novelId)}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// A novel readers have unlocked chapters of is archived rather than deleted.
export function deleteNovel(novelId: string): Promise<{ deleted: boolean; archived: boolean }> {
  return api<{ deleted: boolean; archived: boolean }>(`/admin/novels/${id(novelId)}`, {
    method: 'DELETE',
  });
}

export function bulkNovels(input: {
  ids: string[];
  action: BulkNovelActionName;
  category_id?: string;
}): Promise<{ updated: number }> {
  return api<{ updated: number }>('/admin/novels/bulk', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function uploadNovelCover(novelId: string, file: File): Promise<AdminNovel> {
  const body = new FormData();
  body.append('file', file);
  return api<AdminNovel>(`/admin/novels/${id(novelId)}/cover`, { method: 'POST', body });
}

// Plain links: the browser sends the session cookie and saves the attachment itself.
export function novelExportUrl(novelId: string, format: ExportFormat): string {
  return `/admin/novels/${id(novelId)}/export?format=${format}`;
}

export const NOVELS_CSV_URL = '/admin/novels/export.csv';

export function getNovelStats(novelId: string, days: number): Promise<NovelStats> {
  return api<NovelStats>(`/admin/novels/${id(novelId)}/stats${queryString({ days })}`);
}

export function getTopNovels(days: number): Promise<TopNovels> {
  return api<TopNovels>(`/admin/novels/stats/top${queryString({ days })}`);
}

// ---- Chapters ----

export function listChapters(
  novelId: string,
  params: { after?: number; q?: string },
): Promise<ChapterList> {
  return api<ChapterList>(
    `/admin/novels/${id(novelId)}/chapters${queryString({ ...params, limit: 100 })}`,
  );
}

export function getChapter(novelId: string, chapterId: string): Promise<AdminChapter> {
  return api<AdminChapter>(`/admin/novels/${id(novelId)}/chapters/${id(chapterId)}`);
}

export function createChapter(
  novelId: string,
  input: ChapterInput & { content: string },
): Promise<AdminChapter> {
  return api<AdminChapter>(`/admin/novels/${id(novelId)}/chapters`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateChapter(
  novelId: string,
  chapterId: string,
  input: ChapterInput,
): Promise<AdminChapter> {
  return api<AdminChapter>(`/admin/novels/${id(novelId)}/chapters/${id(chapterId)}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteChapter(novelId: string, chapterId: string): Promise<{ deleted: boolean }> {
  return api<{ deleted: boolean }>(`/admin/novels/${id(novelId)}/chapters/${id(chapterId)}`, {
    method: 'DELETE',
  });
}

export function bulkChapters(
  novelId: string,
  input: {
    ids: string[];
    action: BulkChapterActionName;
    unlock_coin_price?: number | null;
    publish_at?: string | null;
  },
): Promise<{ updated: number }> {
  return api<{ updated: number }>(`/admin/novels/${id(novelId)}/chapters/bulk`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function renumberChapters(novelId: string): Promise<{ renumbered: number }> {
  return api<{ renumbered: number }>(`/admin/novels/${id(novelId)}/chapters/renumber`, {
    method: 'POST',
  });
}

export function listChapterRevisions(
  novelId: string,
  chapterId: string,
): Promise<{ items: ChapterRevision[] }> {
  return api<{ items: ChapterRevision[] }>(
    `/admin/novels/${id(novelId)}/chapters/${id(chapterId)}/revisions`,
  );
}

export function restoreChapterRevision(
  novelId: string,
  chapterId: string,
  revisionId: string,
): Promise<AdminChapter> {
  return api<AdminChapter>(
    `/admin/novels/${id(novelId)}/chapters/${id(chapterId)}/revisions/${id(revisionId)}/restore`,
    { method: 'POST' },
  );
}

// ---- Reading reward settings ----

export function getNovelSettings(): Promise<NovelSettingsData> {
  return api<NovelSettingsData>('/admin/novel/settings');
}

export function updateNovelSettings(
  regionId: string,
  input: NovelRegionSettingsInput,
): Promise<NovelRegionSettings> {
  return api<NovelRegionSettings>(`/admin/novel/settings/${id(regionId)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

// ---- Imports ----

export function listImportJobs(): Promise<{ items: ImportJob[] }> {
  return api<{ items: ImportJob[] }>('/admin/novel-imports?limit=30');
}

export function getImportJob(jobId: string): Promise<ImportJob> {
  return api<ImportJob>(`/admin/novel-imports/${id(jobId)}`);
}

export function listImportChapters(
  jobId: string,
  params: { novel_index: number; after?: number },
): Promise<ImportChapterPage> {
  return api<ImportChapterPage>(
    `/admin/novel-imports/${id(jobId)}/chapters${queryString({ ...params, limit: 100 })}`,
  );
}

// Text fields go before the file: the server reads them off the file part, which only carries
// fields that arrived ahead of it.
export function createImportJob(input: {
  file: File;
  format?: ImportFormat;
  mode: ImportMode;
  target_novel_id?: string;
  chapter_pattern?: string;
}): Promise<ImportJob> {
  const body = new FormData();
  if (input.format) body.append('format', input.format);
  body.append('mode', input.mode);
  if (input.target_novel_id) body.append('target_novel_id', input.target_novel_id);
  if (input.chapter_pattern) body.append('chapter_pattern', input.chapter_pattern);
  body.append('file', input.file);
  return api<ImportJob>('/admin/novel-imports', { method: 'POST', body });
}

export function commitImportJob(jobId: string, input: CommitImportInput): Promise<ImportJob> {
  return api<ImportJob>(`/admin/novel-imports/${id(jobId)}/commit`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function cancelImportJob(jobId: string): Promise<ImportJob> {
  return api<ImportJob>(`/admin/novel-imports/${id(jobId)}/cancel`, { method: 'POST' });
}
