// The Novels page of the CMS: novel list, novel/chapter editors, import wizard, categories and
// reading stats. Kept out of main.ts, which hands it the shell and status plumbing through
// NovelsHost so this module never imports main.ts back.
import {
  bulkChapters,
  bulkNovels,
  cancelImportJob,
  commitImportJob,
  createChapter,
  createImportJob,
  createNovel,
  createNovelCategory,
  deleteChapter,
  deleteNovel,
  deleteNovelCategory,
  getChapter,
  getImportJob,
  getNovel,
  getNovelStats,
  getTopNovels,
  listChapterRevisions,
  listChapters,
  listImportChapters,
  listImportJobs,
  listNovelCategories,
  listNovels,
  novelExportUrl,
  NOVELS_CSV_URL,
  renumberChapters,
  restoreChapterRevision,
  updateChapter,
  updateNovel,
  updateNovelCategory,
  uploadNovelCover,
  type AdminCategory,
  type AdminChapter,
  type AdminChapterSummary,
  type AdminNovel,
  type BulkChapterActionName,
  type BulkNovelActionName,
  type ChapterInput,
  type ChapterRevision,
  type CommitImportInput,
  type ImportChapterPage,
  type ImportFormat,
  type ImportJob,
  type ImportMode,
  type NovelInput,
  type NovelList,
  type NovelListQuery,
  type NovelStats,
  type TopNovels,
} from './novels-api.js';
import {
  errorMessage,
  escapeHtml,
  formatDate,
  integer,
  isoDateTime,
  localDateTime,
  splitValues,
} from './format.js';

export interface NovelsHost {
  root: HTMLElement;
  shell(content: string): string;
  wireShell(): void;
  // Updates main.ts' loading/error banner and re-renders the current page.
  setStatus(next: { loading?: boolean; error?: string | null }): void;
  isActive(): boolean;
  role(): string | undefined;
}

type NovelsTab = 'novels' | 'imports' | 'categories' | 'stats';

interface NovelsState {
  tab: NovelsTab;
  categories: AdminCategory[] | null;
  list: NovelList | null;
  query: NovelListQuery;
  // Offsets already visited, oldest first — the list only hands back a forward cursor.
  history: string[];
  selected: Set<string>;
  novel: AdminNovel | null;
  creatingNovel: boolean;
  chapters: AdminChapterSummary[];
  chapterQuery: { q: string; after?: number };
  chapterHistory: number[];
  chapterNextAfter: number | null;
  chapterSelected: Set<string>;
  chapter: AdminChapter | null;
  creatingChapter: boolean;
  revisions: ChapterRevision[] | null;
  novelStats: NovelStats | null;
  statsDays: number;
  imports: ImportJob[] | null;
  importJob: ImportJob | null;
  importNovelIndex: number;
  importChapters: ImportChapterPage | null;
  top: TopNovels | null;
}

function initialState(): NovelsState {
  return {
    tab: 'novels',
    categories: null,
    list: null,
    query: { sort: 'updated' },
    history: [],
    selected: new Set(),
    novel: null,
    creatingNovel: false,
    chapters: [],
    chapterQuery: { q: '' },
    chapterHistory: [],
    chapterNextAfter: null,
    chapterSelected: new Set(),
    chapter: null,
    creatingChapter: false,
    revisions: null,
    novelStats: null,
    statsDays: 30,
    imports: null,
    importJob: null,
    importNovelIndex: 0,
    importChapters: null,
    top: null,
  };
}

let ns: NovelsState = initialState();
let host: NovelsHost | null = null;
let pollTimer: number | undefined;

const NOVEL_STATUSES = ['draft', 'published', 'hidden', 'archived'] as const;
const COMPLETION_STATUSES = ['ongoing', 'completed', 'hiatus'] as const;
const IMPORT_FORMATS: ImportFormat[] = ['epub', 'txt', 'md', 'docx', 'json', 'zip'];
const IN_FLIGHT_IMPORT = ['queued', 'parsing', 'committing'];

const BULK_NOVEL_ACTIONS: Array<[BulkNovelActionName, string]> = [
  ['publish', 'Publish'],
  ['hide', 'Hide'],
  ['draft', 'Move to draft'],
  ['archive', 'Archive'],
  ['feature', 'Feature'],
  ['unfeature', 'Unfeature'],
  ['add_category', 'Add category…'],
  ['remove_category', 'Remove category…'],
];

const BULK_CHAPTER_ACTIONS: Array<[BulkChapterActionName, string]> = [
  ['publish', 'Publish'],
  ['draft', 'Move to draft'],
  ['set_vip', 'Mark VIP'],
  ['set_free', 'Mark free'],
  ['inherit_vip', 'Follow novel VIP policy'],
  ['set_price', 'Set unlock price…'],
  ['schedule', 'Schedule publish…'],
  ['delete', 'Delete'],
];

export function resetNovelsState(): void {
  window.clearTimeout(pollTimer);
  ns = initialState();
}

function canEdit(): boolean {
  const role = host?.role();
  return role === 'editor' || role === 'superadmin';
}

function rerender(): void {
  host?.setStatus({});
}

// Same contract as runAction in main.ts: the banner shows while the action runs, the result is
// applied to module state, and a failure lands in the error banner instead of being thrown.
async function run<T>(
  action: () => Promise<T>,
  after?: (value: T) => void | Promise<void>,
): Promise<void> {
  host?.setStatus({ loading: true, error: null });
  try {
    const value = await action();
    await after?.(value);
    host?.setStatus({ loading: false });
  } catch (error) {
    host?.setStatus({ loading: false, error: errorMessage(error) });
  }
}

// Mirrors countWords in src/modules/novel/text.ts so the live count matches what the server stores:
// CJK characters count one word each, everything else splits on whitespace.
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/gu;

function countWords(text: string): number {
  const cjkCount = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, ' ').trim();
  return cjkCount + (rest === '' ? 0 : rest.split(/\s+/u).length);
}

function optionList(
  values: readonly string[],
  selected: string | undefined,
  blank?: string,
): string {
  return [
    ...(blank === undefined ? [] : [`<option value="">${escapeHtml(blank)}</option>`]),
    ...values.map(
      (value) =>
        `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(value)}</option>`,
    ),
  ].join('');
}

function categoryName(id: string): string {
  return ns.categories?.find((category) => category.id === id)?.name ?? id.slice(0, 8);
}

// ---- Loading ----

function novelsRequest(): Promise<NovelList> {
  return listNovels(ns.query);
}

async function ensureCategories(): Promise<void> {
  if (!ns.categories) ns.categories = (await listNovelCategories()).items;
}

export async function loadNovelsPage(nextHost: NovelsHost): Promise<void> {
  host = nextHost;
  resetNovelsState();
  await run(async () => {
    const [categories, list] = await Promise.all([listNovelCategories(), novelsRequest()]);
    ns.categories = categories.items;
    ns.list = list;
  });
}

async function chaptersRequest(novelId: string): Promise<void> {
  const page = await listChapters(novelId, {
    ...(ns.chapterQuery.after !== undefined ? { after: ns.chapterQuery.after } : {}),
    ...(ns.chapterQuery.q ? { q: ns.chapterQuery.q } : {}),
  });
  ns.chapters = page.items;
  ns.chapterNextAfter = page.next_after;
  ns.chapterSelected = new Set();
}

async function openNovel(novelId: string): Promise<void> {
  await run(async () => {
    await ensureCategories();
    ns.novel = await getNovel(novelId);
    ns.creatingNovel = false;
    ns.chapter = null;
    ns.creatingChapter = false;
    ns.revisions = null;
    ns.novelStats = null;
    ns.chapterQuery = { q: '' };
    ns.chapterHistory = [];
    await chaptersRequest(novelId);
  });
}

async function refreshList(): Promise<void> {
  ns.list = await novelsRequest();
  ns.selected = new Set();
}

function schedulePoll(): void {
  window.clearTimeout(pollTimer);
  const job = ns.importJob;
  if (!job || !IN_FLIGHT_IMPORT.includes(job.status)) return;
  pollTimer = window.setTimeout(() => {
    if (!host?.isActive() || ns.tab !== 'imports' || ns.importJob?.id !== job.id) return;
    void getImportJob(job.id)
      .then(async (next) => {
        ns.importJob = next;
        if (next.status === 'ready' && next.preview) {
          ns.importNovelIndex = 0;
          ns.importChapters = await listImportChapters(next.id, { novel_index: 0 });
        }
        rerender();
      })
      .catch((error: unknown) => host?.setStatus({ error: errorMessage(error) }));
  }, 2000);
}

async function openImport(jobId: string): Promise<void> {
  await run(async () => {
    await ensureCategories();
    ns.importJob = await getImportJob(jobId);
    ns.importNovelIndex = 0;
    ns.importChapters =
      ns.importJob.status === 'ready' && ns.importJob.preview
        ? await listImportChapters(jobId, { novel_index: 0 })
        : null;
  });
}

// ---- Rendering ----

export function renderNovelsPage(nextHost: NovelsHost): void {
  host = nextHost;
  const tabs: Array<[NovelsTab, string]> = [
    ['novels', 'Novels'],
    ...(canEdit() ? ([['imports', 'Import']] as Array<[NovelsTab, string]>) : []),
    ['categories', 'Categories'],
    ['stats', 'Top novels'],
  ];
  let body = '';
  if (ns.tab === 'novels') {
    if (ns.chapter || ns.creatingChapter) body = chapterEditor();
    else if (ns.novel || ns.creatingNovel) body = novelDetail();
    else body = novelList();
  }
  if (ns.tab === 'imports') body = ns.importJob ? importJobView(ns.importJob) : importsView();
  if (ns.tab === 'categories') body = categoriesView();
  if (ns.tab === 'stats') body = topView();

  nextHost.root.innerHTML = nextHost.shell(`
    <section class="page-header">
      <div>
        <p class="eyebrow">Content</p>
        <h2>Novels</h2>
      </div>
      <a class="button-link secondary-link" href="${NOVELS_CSV_URL}" download>Export CSV</a>
    </section>
    <div class="tab-bar">${tabs
      .map(
        ([tab, label]) =>
          `<button class="tab-button ${ns.tab === tab ? 'active' : ''}" type="button" data-novels-tab="${tab}">${label}</button>`,
      )
      .join('')}</div>
    ${body}
  `);
  nextHost.wireShell();
  wireTabs();
  if (ns.tab === 'novels') {
    if (ns.chapter || ns.creatingChapter) wireChapterEditor();
    else if (ns.novel || ns.creatingNovel) wireNovelDetail();
    else wireNovelList();
  }
  if (ns.tab === 'imports') {
    if (ns.importJob) wireImportJob(ns.importJob);
    else wireImports();
    schedulePoll();
  }
  if (ns.tab === 'categories') wireCategories();
  if (ns.tab === 'stats') wireTop();
}

function wireTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-novels-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const tab = button.dataset['novelsTab'] as NovelsTab;
      ns.tab = tab;
      if (tab === 'imports') {
        ns.importJob = null;
        void run(async () => {
          ns.imports = (await listImportJobs()).items;
        });
        return;
      }
      if (tab === 'categories') {
        void run(async () => {
          ns.categories = (await listNovelCategories()).items;
        });
        return;
      }
      if (tab === 'stats' && !ns.top) {
        void run(async () => {
          ns.top = await getTopNovels(ns.statsDays);
        });
        return;
      }
      rerender();
    });
  });
}

// ---- Novel list ----

function novelList(): string {
  const items = ns.list?.items ?? [];
  const q = ns.query;
  const allSelected = items.length > 0 && items.every((item) => ns.selected.has(item.id));
  return `
    <section class="panel novel-filter-panel">
      <form id="novelFilter" class="novel-filter">
        <label>Search<input name="q" value="${escapeHtml(q.q ?? '')}" placeholder="Title, alt title or author" /></label>
        <label>Status<select name="status">${optionList(NOVEL_STATUSES, q.status, 'Any')}</select></label>
        <label>Completion<select name="completion_status">${optionList(COMPLETION_STATUSES, q.completion_status, 'Any')}</select></label>
        <label>Category<select name="category_id"><option value="">Any</option>${(
          ns.categories ?? []
        )
          .map(
            (category) =>
              `<option value="${escapeHtml(category.id)}" ${q.category_id === category.id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`,
          )
          .join('')}</select></label>
        <label>Language<input name="language" value="${escapeHtml(q.language ?? '')}" placeholder="vi" /></label>
        <label>Featured<select name="featured">
          <option value="">Any</option>
          <option value="true" ${q.featured === 'true' ? 'selected' : ''}>Featured</option>
          <option value="false" ${q.featured === 'false' ? 'selected' : ''}>Not featured</option>
        </select></label>
        <label>Sort<select name="sort">
          <option value="updated" ${q.sort === 'updated' ? 'selected' : ''}>Recently updated</option>
          <option value="created" ${q.sort === 'created' ? 'selected' : ''}>Newest</option>
          <option value="title" ${q.sort === 'title' ? 'selected' : ''}>Title</option>
        </select></label>
        <div class="form-actions"><button type="submit">Filter</button></div>
      </form>
    </section>
    <section class="toolbar-row">
      ${
        canEdit()
          ? `<form id="novelBulk" class="inline-form">
        <select name="action">${BULK_NOVEL_ACTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>
        <select name="category_id"><option value="">Category for add/remove</option>${(
          ns.categories ?? []
        )
          .map(
            (category) =>
              `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`,
          )
          .join('')}</select>
        <button type="submit" ${ns.selected.size === 0 ? 'disabled' : ''}>Apply to ${ns.selected.size} selected</button>
      </form>
      <button type="button" id="newNovel">New novel</button>`
          : `<span class="muted">${integer(ns.list?.total ?? 0)} novels</span>`
      }
    </section>
    <section class="panel table-wrap">
      <table>
        <thead><tr>
          <th class="select-cell"><input type="checkbox" id="selectAllNovels" ${allSelected ? 'checked' : ''} aria-label="Select all" /></th>
          <th>Novel</th><th>Status</th><th>Chapters</th><th>Words</th><th>Categories</th><th>Updated</th><th></th>
        </tr></thead>
        <tbody>
          ${
            items.length > 0
              ? items
                  .map(
                    (novel) => `<tr>
              <td class="select-cell"><input type="checkbox" data-novel-select="${escapeHtml(novel.id)}" ${ns.selected.has(novel.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(novel.title)}" /></td>
              <td><div class="novel-cell">
                ${novel.cover_url ? `<img class="novel-cover-thumb" src="${escapeHtml(novel.cover_url)}" alt="" />` : '<span class="novel-cover-thumb empty"></span>'}
                <div><strong>${escapeHtml(novel.title)}</strong><small>${escapeHtml(novel.author ?? 'Unknown author')} · ${escapeHtml(novel.language)}${novel.is_featured ? ` · ★ featured #${novel.featured_rank}` : ''}</small></div>
              </div></td>
              <td><span class="pill novel-status-${novel.status}">${novel.status}</span><small>${novel.completion_status}</small></td>
              <td>${integer(novel.chapter_count)}<small>${integer(novel.total_chapter_count)} total</small></td>
              <td>${integer(novel.word_count)}</td>
              <td>${escapeHtml(novel.category_ids.map(categoryName).join(', ') || '—')}</td>
              <td>${formatDate(novel.updated_at)}</td>
              <td class="row-actions"><button class="secondary" data-novel-open="${escapeHtml(novel.id)}">Open</button></td>
            </tr>`,
                  )
                  .join('')
              : '<tr><td colspan="8" class="empty-state">No novels match this filter.</td></tr>'
          }
        </tbody>
      </table>
      <div class="monitor-pagination">
        <span>Page ${ns.history.length + 1} · ${integer(ns.list?.total ?? 0)} novels</span>
        <div class="row-actions">
          <button type="button" class="secondary" id="previousNovelPage" ${ns.history.length === 0 ? 'disabled' : ''}>Previous</button>
          <button type="button" class="secondary" id="nextNovelPage" ${ns.list?.next_cursor ? '' : 'disabled'}>Next</button>
        </div>
      </div>
    </section>`;
}

function wireNovelList(): void {
  document.querySelector<HTMLFormElement>('#novelFilter')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const text = (key: string): string => String(form.get(key) ?? '').trim();
    const query: NovelListQuery = {
      sort: (text('sort') || 'updated') as NonNullable<NovelListQuery['sort']>,
    };
    if (text('q')) query.q = text('q');
    if (text('status')) query.status = text('status') as NonNullable<NovelListQuery['status']>;
    if (text('completion_status'))
      query.completion_status = text('completion_status') as NonNullable<
        NovelListQuery['completion_status']
      >;
    if (text('category_id')) query.category_id = text('category_id');
    if (text('language')) query.language = text('language');
    if (text('featured')) query.featured = text('featured') as 'true' | 'false';
    ns.query = query;
    ns.history = [];
    void run(refreshList);
  });
  document.querySelector<HTMLButtonElement>('#nextNovelPage')?.addEventListener('click', () => {
    const cursor = ns.list?.next_cursor;
    if (!cursor) return;
    ns.history.push(ns.query.cursor ?? '');
    ns.query = { ...ns.query, cursor };
    void run(refreshList);
  });
  document.querySelector<HTMLButtonElement>('#previousNovelPage')?.addEventListener('click', () => {
    const cursor = ns.history.pop();
    const base = { ...ns.query };
    delete base.cursor;
    ns.query = cursor ? { ...base, cursor } : base;
    void run(refreshList);
  });
  document
    .querySelector<HTMLInputElement>('#selectAllNovels')
    ?.addEventListener('change', (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      ns.selected = new Set(checked ? (ns.list?.items ?? []).map((item) => item.id) : []);
      rerender();
    });
  document.querySelectorAll<HTMLInputElement>('[data-novel-select]').forEach((input) => {
    input.addEventListener('change', () => {
      const novelId = input.dataset['novelSelect'] ?? '';
      if (input.checked) ns.selected.add(novelId);
      else ns.selected.delete(novelId);
      rerender();
    });
  });
  document.querySelector<HTMLFormElement>('#novelBulk')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const action = String(form.get('action')) as BulkNovelActionName;
    const categoryId = String(form.get('category_id') ?? '');
    const needsCategory = action === 'add_category' || action === 'remove_category';
    if (needsCategory && !categoryId) {
      host?.setStatus({ error: 'Pick a category for this bulk action.' });
      return;
    }
    if (action === 'archive' && !window.confirm(`Archive ${ns.selected.size} novels?`)) return;
    void run(async () => {
      await bulkNovels({
        ids: [...ns.selected],
        action,
        ...(needsCategory ? { category_id: categoryId } : {}),
      });
      await refreshList();
    });
  });
  document.querySelector<HTMLButtonElement>('#newNovel')?.addEventListener('click', () => {
    ns.novel = null;
    ns.creatingNovel = true;
    rerender();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-novel-open]').forEach((button) => {
    button.addEventListener('click', () => void openNovel(button.dataset['novelOpen'] ?? ''));
  });
}

// ---- Novel detail: metadata + chapters + stats ----

function novelForm(novel: AdminNovel | null): string {
  const disabled = canEdit() ? '' : 'disabled';
  const selectedCategories = new Set(novel?.category_ids ?? []);
  return `<form id="novelForm" class="form-grid">
    <fieldset class="field-wide form-grid novel-fieldset" ${disabled}>
      <label class="field-wide">Title<input name="title" value="${escapeHtml(novel?.title ?? '')}" maxlength="300" required /></label>
      <label>Slug<input name="slug" value="${escapeHtml(novel?.slug ?? '')}" pattern="[a-z0-9-]{1,100}" placeholder="Generated from the title" /></label>
      <label>Language<input name="language" value="${escapeHtml(novel?.language ?? 'vi')}" minlength="2" maxlength="10" required /></label>
      <label>Author<input name="author" value="${escapeHtml(novel?.author ?? '')}" maxlength="200" /></label>
      <label>Translator<input name="translator" value="${escapeHtml(novel?.translator ?? '')}" maxlength="200" /></label>
      <label class="field-wide">Alternative titles<input name="alt_titles" value="${escapeHtml((novel?.alt_titles ?? []).join(', '))}" /><small>Comma or newline separated — included in search.</small></label>
      <label class="field-wide">Description<textarea name="description" rows="5" maxlength="20000">${escapeHtml(novel?.description ?? '')}</textarea></label>
      <label>Status<select name="status">${optionList(NOVEL_STATUSES, novel?.status ?? 'draft')}</select></label>
      <label>Completion<select name="completion_status">${optionList(COMPLETION_STATUSES, novel?.completion_status ?? 'ongoing')}</select></label>
      <label>Tags<input name="tags" value="${escapeHtml((novel?.tags ?? []).join(', '))}" placeholder="tiên hiệp, xuyên không" /></label>
      <label>Regions<input name="regions" value="${escapeHtml((novel?.regions ?? []).join(', '))}" placeholder="Empty = every region" /><small>Region ids, comma separated.</small></label>
      <fieldset class="check-group field-wide"><legend>Categories</legend>
        ${
          (ns.categories ?? []).length > 0
            ? (ns.categories ?? [])
                .map(
                  (category) =>
                    `<label class="check-label"><input type="checkbox" name="category_ids" value="${escapeHtml(category.id)}" ${selectedCategories.has(category.id) ? 'checked' : ''} />${escapeHtml(category.name)}${category.is_active ? '' : ' (inactive)'}</label>`,
                )
                .join('')
            : '<span class="muted">No categories yet — create them in the Categories tab.</span>'
        }
      </fieldset>
      <fieldset class="check-group field-wide vip-policy"><legend>VIP policy</legend>
        <label>VIP from chapter<input name="vip_from_chapter" type="number" min="1" step="1" value="${novel?.vip_from_chapter ?? ''}" placeholder="Empty = all free" /><small>Chapters before this number are free. A chapter's own VIP flag overrides it.</small></label>
        <label>Default unlock price (coin)<input name="default_unlock_coin" type="number" min="0" max="1000000" step="1" value="${novel?.default_unlock_coin ?? 0}" required /></label>
        <label class="switch-label"><input name="allow_ad_unlock" type="checkbox" ${(novel?.allow_ad_unlock ?? true) ? 'checked' : ''} /> Allow unlocking with a rewarded ad</label>
      </fieldset>
      <fieldset class="check-group field-wide"><legend>Shown to readers</legend>
        <label>Rating<input name="rating" type="number" min="0" max="5" step="0.1" value="${novel?.rating ?? ''}" placeholder="Empty = no stars" /><small>0–5, one decimal.</small></label>
        <label class="switch-label"><input name="ai_generated" type="checkbox" ${novel?.ai_generated ? 'checked' : ''} /> AI-generated</label>
        <label class="switch-label"><input name="editor_reviewed" type="checkbox" ${novel?.editor_reviewed ? 'checked' : ''} /> Editor reviewed</label>
      </fieldset>
      <label class="switch-label"><input name="is_featured" type="checkbox" ${novel?.is_featured ? 'checked' : ''} /> Featured on the app home</label>
      <label>Featured rank<input name="featured_rank" type="number" min="-100000" max="100000" step="1" value="${novel?.featured_rank ?? 0}" /><small>Lower shows first.</small></label>
    </fieldset>
    ${
      canEdit()
        ? `<div class="form-actions field-wide">
        <button type="submit">${novel ? 'Save novel' : 'Create novel'}</button>
        ${novel ? `<span class="muted">Updated ${formatDate(novel.updated_at)}${novel.published_at ? ` · published ${formatDate(novel.published_at)}` : ''}</span>` : '<span class="muted">Readers only see published novels with published chapters.</span>'}
      </div>`
        : ''
    }
  </form>`;
}

function novelInputFromForm(form: HTMLFormElement): NovelInput {
  const values = new FormData(form);
  const text = (key: string): string => String(values.get(key) ?? '').trim();
  const nullable = (key: string): string | null => text(key) || null;
  const regions = splitValues(values.get('regions'));
  const vipFrom = text('vip_from_chapter');
  const rating = text('rating');
  return {
    title: text('title'),
    ...(text('slug') ? { slug: text('slug') } : {}),
    alt_titles: splitValues(values.get('alt_titles')),
    author: nullable('author'),
    translator: nullable('translator'),
    description: nullable('description'),
    status: text('status') as NovelInput['status'],
    completion_status: text('completion_status') as NovelInput['completion_status'],
    language: text('language'),
    tags: splitValues(values.get('tags')),
    regions: regions.length > 0 ? regions : null,
    is_featured: values.get('is_featured') === 'on',
    featured_rank: Number(text('featured_rank') || 0),
    vip_from_chapter: vipFrom ? Number(vipFrom) : null,
    default_unlock_coin: Number(text('default_unlock_coin') || 0),
    allow_ad_unlock: values.get('allow_ad_unlock') === 'on',
    category_ids: values.getAll('category_ids').map(String),
    rating: rating ? Number(rating) : null,
    ai_generated: values.get('ai_generated') === 'on',
    editor_reviewed: values.get('editor_reviewed') === 'on',
  };
}

function novelSidebar(novel: AdminNovel): string {
  return `<aside class="novel-side">
    <article class="panel">
      <p class="eyebrow">Cover</p>
      ${novel.cover_url ? `<img class="novel-cover-large" src="${escapeHtml(novel.cover_url)}" alt="Cover of ${escapeHtml(novel.title)}" />` : '<div class="novel-cover-large empty">No cover</div>'}
      ${
        canEdit()
          ? `<form id="coverForm" class="form-stack">
        <input name="file" type="file" accept="image/jpeg,image/png,image/webp" required />
        <button type="submit" class="secondary">Upload cover</button>
        <small class="muted">JPEG, PNG or WebP, up to 5 MB.</small>
      </form>`
          : ''
      }
    </article>
    <article class="panel">
      <p class="eyebrow">Overview</p>
      <dl class="details-grid">
        <dt>Published chapters</dt><dd>${integer(novel.chapter_count)}</dd>
        <dt>All chapters</dt><dd>${integer(novel.total_chapter_count)}</dd>
        <dt>Words</dt><dd>${integer(novel.word_count)}</dd>
        <dt>Readers</dt><dd>${integer(novel.read_count)}</dd>
        <dt>Created</dt><dd>${formatDate(novel.created_at)}</dd>
      </dl>
    </article>
    ${
      canEdit()
        ? `<article class="panel">
      <p class="eyebrow">Export</p>
      <div class="row-actions">
        ${(['zip', 'json', 'epub', 'txt'] as const)
          .map(
            (format) =>
              `<a class="button-link secondary-link small-link" href="${novelExportUrl(novel.id, format)}" download>${format.toUpperCase()}</a>`,
          )
          .join('')}
      </div>
      <small class="muted">ZIP/JSON round-trip through Import for backups and moving between environments.</small>
    </article>
    <article class="panel">
      <p class="eyebrow">Danger zone</p>
      <button type="button" class="danger" id="deleteNovel">Delete novel</button>
      <small class="muted">A novel readers have unlocked chapters of is archived instead.</small>
    </article>`
        : ''
    }
  </aside>`;
}

function chapterTable(novel: AdminNovel): string {
  const allSelected =
    ns.chapters.length > 0 && ns.chapters.every((chapter) => ns.chapterSelected.has(chapter.id));
  return `<section class="panel">
    <div class="section-heading">
      <div><p class="eyebrow">Table of contents</p><h3>Chapters</h3></div>
      ${
        canEdit()
          ? `<div class="row-actions">
        <button type="button" class="secondary" id="renumberChapters" title="Close gaps left by deletes: chapters keep their order and become 1..N">Renumber 1..N</button>
        <button type="button" id="newChapter">New chapter</button>
      </div>`
          : ''
      }
    </div>
    <div class="toolbar-row chapter-toolbar">
      <form id="chapterFilter" class="inline-form">
        <input name="q" value="${escapeHtml(ns.chapterQuery.q)}" placeholder="Search chapter titles" />
        <button type="submit" class="secondary">Search</button>
      </form>
      ${
        canEdit()
          ? `<form id="chapterBulk" class="inline-form">
        <select name="action">${BULK_CHAPTER_ACTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>
        <input name="unlock_coin_price" type="number" min="0" max="1000000" step="1" placeholder="Price (empty = default)" />
        <input name="publish_at" type="datetime-local" />
        <button type="submit" ${ns.chapterSelected.size === 0 ? 'disabled' : ''}>Apply to ${ns.chapterSelected.size}</button>
      </form>`
          : ''
      }
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th class="select-cell"><input type="checkbox" id="selectAllChapters" ${allSelected ? 'checked' : ''} aria-label="Select all chapters" /></th>
          <th>#</th><th>Title</th><th>Words</th><th>Access</th><th>Status</th><th>Updated</th><th></th>
        </tr></thead>
        <tbody>
          ${
            ns.chapters.length > 0
              ? ns.chapters
                  .map((chapter) => {
                    const price = chapter.unlock_coin_price ?? novel.default_unlock_coin;
                    const access = chapter.effective_vip
                      ? `<span class="pill novel-vip">VIP · ${integer(price)} coin</span>`
                      : '<span class="pill">free</span>';
                    const source = chapter.is_vip === null ? 'novel policy' : 'chapter override';
                    const scheduled =
                      chapter.publish_at && new Date(chapter.publish_at).getTime() > Date.now();
                    return `<tr>
              <td class="select-cell"><input type="checkbox" data-chapter-select="${escapeHtml(chapter.id)}" ${ns.chapterSelected.has(chapter.id) ? 'checked' : ''} aria-label="Select chapter ${chapter.chapter_no}" /></td>
              <td>${chapter.chapter_no}</td>
              <td><strong>${escapeHtml(chapter.title || '(untitled)')}</strong></td>
              <td>${integer(chapter.word_count)}</td>
              <td>${access}<small>${source}</small></td>
              <td><span class="pill novel-status-${chapter.status}">${chapter.status}</span>${scheduled ? `<small>goes live ${formatDate(chapter.publish_at)}</small>` : ''}</td>
              <td>${formatDate(chapter.updated_at)}</td>
              <td class="row-actions"><button class="secondary" data-chapter-open="${escapeHtml(chapter.id)}">${canEdit() ? 'Edit' : 'View'}</button></td>
            </tr>`;
                  })
                  .join('')
              : '<tr><td colspan="8" class="empty-state">No chapters yet. Add one or import a file.</td></tr>'
          }
        </tbody>
      </table>
    </div>
    <div class="monitor-pagination">
      <span>Page ${ns.chapterHistory.length + 1} · 100 chapters per page</span>
      <div class="row-actions">
        <button type="button" class="secondary" id="previousChapterPage" ${ns.chapterHistory.length === 0 ? 'disabled' : ''}>Previous</button>
        <button type="button" class="secondary" id="nextChapterPage" ${ns.chapterNextAfter === null ? 'disabled' : ''}>Next</button>
      </div>
    </div>
  </section>`;
}

function novelStatsPanel(): string {
  const stats = ns.novelStats;
  if (!stats) {
    return `<section class="panel"><div class="section-heading"><div><p class="eyebrow">Reading</p><h3>Stats</h3></div><button type="button" class="secondary" id="loadNovelStats">Load last ${ns.statsDays} days</button></div></section>`;
  }
  const metrics: Array<[string, number]> = [
    ['Readers', stats.readers],
    ['Chapter reads', stats.chapter_reads],
    ['Completions', stats.completions],
    ['Rewarded chapters', stats.rewarded_chapters],
    ['Coin rewarded', stats.coin_rewarded],
    ['Coin unlocks', stats.unlocks_coin],
    ['Ad unlocks', stats.unlocks_ad],
    ['Coin spent', stats.coin_spent],
    ['On bookshelves', stats.bookshelf_count],
  ];
  return `<section class="panel">
    <div class="section-heading"><div><p class="eyebrow">Reading · last ${stats.days} days</p><h3>Stats</h3></div></div>
    <div class="novel-metrics">${metrics
      .map(
        ([label, value]) =>
          `<article><span>${label}</span><strong>${integer(value)}</strong></article>`,
      )
      .join('')}</div>
    <div class="table-wrap">
      <table class="compact-table">
        <thead><tr><th>#</th><th>Chapter</th><th>Readers</th><th>Completions</th><th>Drop-off</th><th>Unlocks</th></tr></thead>
        <tbody>${
          stats.chapters.length > 0
            ? stats.chapters
                .map((chapter, index) => {
                  const previous = index > 0 ? stats.chapters[index - 1] : undefined;
                  const drop =
                    previous && previous.readers > 0
                      ? `${Math.round((1 - chapter.readers / previous.readers) * 100)}%`
                      : '—';
                  return `<tr><td>${chapter.chapter_no}</td><td>${escapeHtml(chapter.title)}</td><td>${integer(chapter.readers)}</td><td>${integer(chapter.completions)}</td><td>${drop}</td><td>${integer(chapter.unlocks)}</td></tr>`;
                })
                .join('')
            : '<tr><td colspan="6" class="empty-state">No reading activity in this window.</td></tr>'
        }</tbody>
      </table>
    </div>
  </section>`;
}

function novelDetail(): string {
  const novel = ns.novel;
  return `
    <section class="toolbar-row">
      <button type="button" class="secondary" id="backToNovels">← All novels</button>
      ${novel ? `<span class="pill novel-status-${novel.status}">${novel.status}</span>` : ''}
    </section>
    <div class="novel-layout">
      <article class="panel">
        <div class="section-heading"><div><p class="eyebrow">${novel ? 'Edit novel' : 'New novel'}</p><h3>${escapeHtml(novel?.title ?? 'Create novel')}</h3></div></div>
        ${novelForm(novel)}
      </article>
      ${novel ? novelSidebar(novel) : ''}
    </div>
    ${novel ? chapterTable(novel) : ''}
    ${novel ? novelStatsPanel() : ''}`;
}

function wireNovelDetail(): void {
  const novel = ns.novel;
  document.querySelector<HTMLButtonElement>('#backToNovels')?.addEventListener('click', () => {
    ns.novel = null;
    ns.creatingNovel = false;
    void run(refreshList);
  });
  document.querySelector<HTMLFormElement>('#novelForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = novelInputFromForm(event.currentTarget as HTMLFormElement);
    void run(async () => {
      if (novel) {
        ns.novel = await updateNovel(novel.id, input);
        return;
      }
      const created = await createNovel(input);
      ns.creatingNovel = false;
      ns.novel = created;
      ns.chapters = [];
      ns.chapterNextAfter = null;
      ns.chapterHistory = [];
    });
  });
  if (!novel) return;

  document.querySelector<HTMLFormElement>('#coverForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const file = new FormData(event.currentTarget as HTMLFormElement).get('file');
    if (!(file instanceof File) || file.size === 0) return;
    void run(async () => {
      ns.novel = await uploadNovelCover(novel.id, file);
    });
  });
  document.querySelector<HTMLButtonElement>('#deleteNovel')?.addEventListener('click', () => {
    if (!window.confirm(`Delete "${novel.title}" and all its chapters?`)) return;
    void run(async () => {
      const result = await deleteNovel(novel.id);
      if (result.archived) {
        ns.novel = await getNovel(novel.id);
        host?.setStatus({
          error: 'Readers have unlocked chapters of this novel — it was archived instead.',
        });
        return;
      }
      ns.novel = null;
      await refreshList();
    });
  });
  document.querySelector<HTMLButtonElement>('#loadNovelStats')?.addEventListener('click', () => {
    void run(async () => {
      ns.novelStats = await getNovelStats(novel.id, ns.statsDays);
    });
  });

  document.querySelector<HTMLFormElement>('#chapterFilter')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = String(new FormData(event.currentTarget as HTMLFormElement).get('q') ?? '').trim();
    ns.chapterQuery = { q };
    ns.chapterHistory = [];
    void run(() => chaptersRequest(novel.id));
  });
  document.querySelector<HTMLButtonElement>('#nextChapterPage')?.addEventListener('click', () => {
    if (ns.chapterNextAfter === null) return;
    ns.chapterHistory.push(ns.chapterQuery.after ?? 0);
    ns.chapterQuery = { ...ns.chapterQuery, after: ns.chapterNextAfter };
    void run(() => chaptersRequest(novel.id));
  });
  document
    .querySelector<HTMLButtonElement>('#previousChapterPage')
    ?.addEventListener('click', () => {
      const after = ns.chapterHistory.pop();
      ns.chapterQuery = after ? { ...ns.chapterQuery, after } : { q: ns.chapterQuery.q };
      void run(() => chaptersRequest(novel.id));
    });
  document
    .querySelector<HTMLInputElement>('#selectAllChapters')
    ?.addEventListener('change', (event) => {
      const checked = (event.currentTarget as HTMLInputElement).checked;
      ns.chapterSelected = new Set(checked ? ns.chapters.map((chapter) => chapter.id) : []);
      rerender();
    });
  document.querySelectorAll<HTMLInputElement>('[data-chapter-select]').forEach((input) => {
    input.addEventListener('change', () => {
      const chapterId = input.dataset['chapterSelect'] ?? '';
      if (input.checked) ns.chapterSelected.add(chapterId);
      else ns.chapterSelected.delete(chapterId);
      rerender();
    });
  });
  document.querySelector<HTMLFormElement>('#chapterBulk')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const action = String(form.get('action')) as BulkChapterActionName;
    const priceRaw = String(form.get('unlock_coin_price') ?? '').trim();
    const publishAt = isoDateTime(form.get('publish_at'));
    if (action === 'schedule' && !publishAt) {
      host?.setStatus({ error: 'Pick a publish date and time to schedule chapters.' });
      return;
    }
    if (action === 'delete' && !window.confirm(`Delete ${ns.chapterSelected.size} chapters?`))
      return;
    void run(async () => {
      await bulkChapters(novel.id, {
        ids: [...ns.chapterSelected],
        action,
        ...(action === 'set_price'
          ? { unlock_coin_price: priceRaw ? Number(priceRaw) : null }
          : {}),
        ...(action === 'schedule' ? { publish_at: publishAt } : {}),
      });
      await chaptersRequest(novel.id);
      ns.novel = await getNovel(novel.id);
    });
  });
  document.querySelector<HTMLButtonElement>('#renumberChapters')?.addEventListener('click', () => {
    if (!window.confirm('Renumber every chapter to 1..N in its current order?')) return;
    void run(async () => {
      await renumberChapters(novel.id);
      ns.chapterQuery = { q: ns.chapterQuery.q };
      ns.chapterHistory = [];
      await chaptersRequest(novel.id);
    });
  });
  document.querySelector<HTMLButtonElement>('#newChapter')?.addEventListener('click', () => {
    ns.chapter = null;
    ns.creatingChapter = true;
    ns.revisions = null;
    rerender();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-chapter-open]').forEach((button) => {
    button.addEventListener('click', () => {
      const chapterId = button.dataset['chapterOpen'] ?? '';
      void run(async () => {
        ns.chapter = await getChapter(novel.id, chapterId);
        ns.creatingChapter = false;
        ns.revisions = null;
      });
    });
  });
}

// ---- Chapter editor ----

function chapterEditor(): string {
  const novel = ns.novel;
  const chapter = ns.chapter;
  const disabled = canEdit() ? '' : 'disabled';
  const vip = chapter?.is_vip === true ? 'vip' : chapter?.is_vip === false ? 'free' : 'inherit';
  return `
    <section class="toolbar-row">
      <button type="button" class="secondary" id="backToNovel">← ${escapeHtml(novel?.title ?? 'Novel')}</button>
      ${chapter ? `<span class="muted">Chapter ${chapter.chapter_no} · ${chapter.effective_vip ? 'VIP' : 'free'}</span>` : ''}
    </section>
    <article class="panel">
      <div class="section-heading"><div><p class="eyebrow">${chapter ? 'Edit chapter' : 'New chapter'}</p><h3>${escapeHtml(chapter?.title || (chapter ? `Chapter ${chapter.chapter_no}` : 'Create chapter'))}</h3></div></div>
      <form id="chapterForm" class="form-grid">
        <fieldset class="field-wide form-grid novel-fieldset" ${disabled}>
          <label>Chapter number<input name="chapter_no" type="number" min="1" max="1000000" step="1" value="${chapter?.chapter_no ?? ''}" placeholder="Empty = after the last chapter" ${chapter ? 'required' : ''} /><small>Changing it moves the chapter in the table of contents.</small></label>
          <label>Title<input name="title" value="${escapeHtml(chapter?.title ?? '')}" maxlength="300" /></label>
          <label>Access<select name="is_vip">
            <option value="inherit" ${vip === 'inherit' ? 'selected' : ''}>Follow novel VIP policy</option>
            <option value="vip" ${vip === 'vip' ? 'selected' : ''}>VIP (locked)</option>
            <option value="free" ${vip === 'free' ? 'selected' : ''}>Free</option>
          </select></label>
          <label>Unlock price (coin)<input name="unlock_coin_price" type="number" min="0" max="1000000" step="1" value="${chapter?.unlock_coin_price ?? ''}" placeholder="Default ${novel?.default_unlock_coin ?? 0}" /></label>
          <label>Status<select name="status">${optionList(['draft', 'published'], chapter?.status ?? 'draft')}</select></label>
          <label>Publish at<input name="publish_at" type="datetime-local" value="${localDateTime(chapter?.publish_at ?? null)}" /><small>A published chapter stays hidden from readers until this time.</small></label>
          <label class="field-wide">Content
            <textarea name="content" id="chapterContent" rows="24" maxlength="400000" required>${escapeHtml(chapter?.content ?? '')}</textarea>
            <small id="chapterWordCount">${integer(countWords(chapter?.content ?? ''))} words</small>
          </label>
        </fieldset>
        <p class="muted field-wide">Plain text — separate paragraphs with a blank line. Only free chapters earn the reading reward.</p>
        ${
          canEdit()
            ? `<div class="form-actions field-wide">
          <button type="submit">${chapter ? 'Save chapter' : 'Create chapter'}</button>
          ${chapter ? '<button type="button" class="secondary" id="loadRevisions">Revision history</button><button type="button" class="danger" id="deleteChapter">Delete chapter</button>' : ''}
          ${chapter ? `<span class="muted">Updated ${formatDate(chapter.updated_at)} · saving keeps the previous text as a revision</span>` : ''}
        </div>`
            : ''
        }
      </form>
    </article>
    ${revisionsPanel()}`;
}

function revisionsPanel(): string {
  if (!ns.revisions) return '';
  return `<section class="panel">
    <div class="section-heading"><div><p class="eyebrow">History</p><h3>Revisions</h3></div></div>
    ${
      ns.revisions.length > 0
        ? `<div class="record-list">${ns.revisions
            .map(
              (revision) => `<details class="record-row revision-row">
            <summary><strong>${escapeHtml(revision.title || '(untitled)')}</strong> · ${formatDate(revision.created_at)} · ${integer(countWords(revision.content))} words${revision.edited_by ? ` · ${escapeHtml(revision.edited_by)}` : ''}</summary>
            <pre class="revision-content">${escapeHtml(revision.content)}</pre>
            <button type="button" class="secondary" data-revision-restore="${escapeHtml(revision.id)}">Restore this version</button>
          </details>`,
            )
            .join('')}</div>`
        : '<p class="muted">No earlier versions — revisions are recorded each time the chapter is saved.</p>'
    }
  </section>`;
}

function chapterInputFromForm(form: HTMLFormElement): ChapterInput & { content: string } {
  const values = new FormData(form);
  const text = (key: string): string => String(values.get(key) ?? '').trim();
  const vip = text('is_vip');
  const input: ChapterInput & { content: string } = {
    title: text('title'),
    content: String(values.get('content') ?? ''),
    is_vip: vip === 'vip' ? true : vip === 'free' ? false : null,
    unlock_coin_price: text('unlock_coin_price') ? Number(text('unlock_coin_price')) : null,
    status: text('status') as NonNullable<ChapterInput['status']>,
    publish_at: isoDateTime(values.get('publish_at')),
  };
  if (text('chapter_no')) input.chapter_no = Number(text('chapter_no'));
  return input;
}

function wireChapterEditor(): void {
  const novel = ns.novel;
  if (!novel) return;
  const chapter = ns.chapter;
  document.querySelector<HTMLButtonElement>('#backToNovel')?.addEventListener('click', () => {
    ns.chapter = null;
    ns.creatingChapter = false;
    ns.revisions = null;
    void run(() => chaptersRequest(novel.id));
  });
  const content = document.querySelector<HTMLTextAreaElement>('#chapterContent');
  const counter = document.querySelector<HTMLElement>('#chapterWordCount');
  content?.addEventListener('input', () => {
    if (counter) counter.textContent = `${integer(countWords(content.value))} words`;
  });
  document.querySelector<HTMLFormElement>('#chapterForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = chapterInputFromForm(event.currentTarget as HTMLFormElement);
    void run(async () => {
      ns.chapter = chapter
        ? await updateChapter(novel.id, chapter.id, input)
        : await createChapter(novel.id, input);
      ns.creatingChapter = false;
      ns.revisions = null;
      ns.novel = await getNovel(novel.id);
    });
  });
  if (!chapter) return;
  document.querySelector<HTMLButtonElement>('#loadRevisions')?.addEventListener('click', () => {
    void run(async () => {
      ns.revisions = (await listChapterRevisions(novel.id, chapter.id)).items;
    });
  });
  document.querySelector<HTMLButtonElement>('#deleteChapter')?.addEventListener('click', () => {
    if (!window.confirm(`Delete chapter ${chapter.chapter_no}?`)) return;
    void run(async () => {
      await deleteChapter(novel.id, chapter.id);
      ns.chapter = null;
      ns.revisions = null;
      ns.novel = await getNovel(novel.id);
      await chaptersRequest(novel.id);
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-revision-restore]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!window.confirm('Replace the current text with this revision?')) return;
      const revisionId = button.dataset['revisionRestore'] ?? '';
      void run(async () => {
        ns.chapter = await restoreChapterRevision(novel.id, chapter.id, revisionId);
        ns.revisions = (await listChapterRevisions(novel.id, chapter.id)).items;
      });
    });
  });
}

// ---- Imports ----

function importStatusPill(status: string): string {
  return `<span class="pill import-status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function importsView(): string {
  const jobs = ns.imports ?? [];
  return `
    <article class="panel">
      <div class="section-heading"><div><p class="eyebrow">Step 1</p><h3>Upload a file</h3></div></div>
      <form id="importForm" class="form-grid">
        <label class="field-wide">File<input name="file" type="file" accept=".epub,.txt,.md,.docx,.json,.zip" required /><small>EPUB, TXT, Markdown, DOCX, or the JSON/ZIP export format. Up to 50 MB.</small></label>
        <label>Format<select name="format"><option value="">Detect from file name</option>${optionList(IMPORT_FORMATS, undefined)}</select></label>
        <label>Mode<select name="mode" id="importMode">
          <option value="new">Create new novel(s)</option>
          <option value="append">Append chapters to an existing novel</option>
          <option value="replace">Replace chapters (matched by number)</option>
        </select></label>
        <label>Target novel id<input name="target_novel_id" placeholder="Required for append / replace" /><small>Copy it from the novel's URL or the novel list.</small></label>
        <label>Chapter heading pattern<input name="chapter_pattern" placeholder="Default: Chương / Chapter / 第 N" /><small>Regular expression for TXT, Markdown and DOCX.</small></label>
        <div class="form-actions field-wide"><button type="submit">Upload and parse</button><span class="muted">Parsing runs in the background; nothing is saved until you confirm the preview.</span></div>
      </form>
    </article>
    <section class="panel table-wrap">
      <div class="section-heading"><div><p class="eyebrow">Recent</p><h3>Import jobs</h3></div><button type="button" class="secondary" id="refreshImports">Refresh</button></div>
      <table>
        <thead><tr><th>File</th><th>Mode</th><th>Status</th><th>Created</th><th>Finished</th><th></th></tr></thead>
        <tbody>${
          jobs.length > 0
            ? jobs
                .map(
                  (job) => `<tr>
              <td><strong>${escapeHtml(job.filename)}</strong><small>${escapeHtml(job.format)}</small></td>
              <td>${escapeHtml(job.mode)}</td>
              <td>${importStatusPill(job.status)}${job.errors.length > 0 ? `<small>${escapeHtml(job.errors[0])}</small>` : ''}</td>
              <td>${formatDate(job.created_at)}</td>
              <td>${formatDate(job.finished_at)}</td>
              <td class="row-actions"><button class="secondary" data-import-open="${escapeHtml(job.id)}">Open</button></td>
            </tr>`,
                )
                .join('')
            : '<tr><td colspan="6" class="empty-state">No imports yet.</td></tr>'
        }</tbody>
      </table>
    </section>`;
}

function wireImports(): void {
  document.querySelector<HTMLFormElement>('#importForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget as HTMLFormElement);
    const file = values.get('file');
    if (!(file instanceof File) || file.size === 0) return;
    const text = (key: string): string => String(values.get(key) ?? '').trim();
    const mode = text('mode') as ImportMode;
    if (mode !== 'new' && !text('target_novel_id')) {
      host?.setStatus({ error: 'Append and replace imports need the target novel id.' });
      return;
    }
    void run(async () => {
      ns.importJob = await createImportJob({
        file,
        mode,
        ...(text('format') ? { format: text('format') as ImportFormat } : {}),
        ...(mode !== 'new' ? { target_novel_id: text('target_novel_id') } : {}),
        ...(text('chapter_pattern') ? { chapter_pattern: text('chapter_pattern') } : {}),
      });
      ns.importChapters = null;
      ns.importNovelIndex = 0;
      await ensureCategories();
    });
  });
  document.querySelector<HTMLButtonElement>('#refreshImports')?.addEventListener('click', () => {
    void run(async () => {
      ns.imports = (await listImportJobs()).items;
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-import-open]').forEach((button) => {
    button.addEventListener('click', () => void openImport(button.dataset['importOpen'] ?? ''));
  });
}

function importPreviewNovelForm(job: ImportJob): string {
  const novels = job.preview?.novels ?? [];
  const isNew = job.mode === 'new';
  return novels
    .map(
      (novel) => `<fieldset class="panel import-novel" data-import-novel="${novel.index}">
      <div class="section-heading">
        <div><p class="eyebrow">Novel ${novel.index + 1} of ${novels.length}</p><h3>${escapeHtml(novel.title)}</h3></div>
        <div class="row-actions">
          <span class="pill">${integer(novel.chapter_count)} chapters · ${integer(novel.word_count)} words</span>
          ${novel.warning_count > 0 ? `<span class="pill import-warning-pill">${integer(novel.warning_count)} warnings</span>` : ''}
          <button type="button" class="secondary" data-import-preview="${novel.index}">${ns.importNovelIndex === novel.index ? 'Previewing' : 'Preview chapters'}</button>
        </div>
      </div>
      ${
        isNew
          ? `<div class="form-grid">
        ${novel.cover_url ? `<img class="novel-cover-thumb large" src="${escapeHtml(novel.cover_url)}" alt="" />` : ''}
        <label class="switch-label"><input type="checkbox" name="skip" /> Skip this novel</label>
        <label class="field-wide">Title<input name="title" value="${escapeHtml(novel.title)}" maxlength="300" required /></label>
        <label>Author<input name="author" value="${escapeHtml(novel.author ?? '')}" maxlength="200" /></label>
        <label>Language<input name="language" value="${escapeHtml(novel.language ?? 'vi')}" minlength="2" maxlength="10" /></label>
        <label class="field-wide">Description<textarea name="description" rows="3" maxlength="20000">${escapeHtml(novel.description ?? '')}</textarea></label>
        <label>Tags<input name="tags" value="${escapeHtml(novel.tags.join(', '))}" /></label>
        <label>Novel status<select name="status">${optionList(['draft', 'published', 'hidden'], 'draft')}</select></label>
        <fieldset class="check-group field-wide"><legend>Categories</legend>${
          (ns.categories ?? [])
            .map(
              (category) =>
                `<label class="check-label"><input type="checkbox" name="category_ids" value="${escapeHtml(category.id)}" />${escapeHtml(category.name)}</label>`,
            )
            .join('') || '<span class="muted">No categories.</span>'
        }</fieldset>
      </div>`
          : `<p class="muted">Chapters will be ${job.mode === 'append' ? 'appended after the last chapter of' : 'replaced by number in'} novel <code>${escapeHtml(job.target_novel_id ?? '')}</code>.</p>`
      }
    </fieldset>`,
    )
    .join('');
}

function importChapterTable(): string {
  const page = ns.importChapters;
  if (!page) return '';
  return `<section class="panel table-wrap">
    <div class="section-heading"><div><p class="eyebrow">Novel ${ns.importNovelIndex + 1}</p><h3>Parsed chapters</h3></div></div>
    <table class="compact-table">
      <thead><tr><th>#</th><th>Title</th><th>Words</th><th>Warnings</th><th>Excerpt</th></tr></thead>
      <tbody>${
        page.items.length > 0
          ? page.items
              .map(
                (
                  chapter,
                ) => `<tr class="${chapter.warnings.length > 0 ? 'import-warning-row' : ''}">
            <td>${chapter.chapter_no}</td>
            <td>${escapeHtml(chapter.title || '(untitled)')}</td>
            <td>${integer(chapter.word_count)}</td>
            <td>${chapter.warnings.map((warning) => `<small>${escapeHtml(warning)}</small>`).join('') || '—'}</td>
            <td><small class="import-excerpt">${escapeHtml(chapter.excerpt)}</small></td>
          </tr>`,
              )
              .join('')
          : '<tr><td colspan="5" class="empty-state">No chapters.</td></tr>'
      }</tbody>
    </table>
    <div class="monitor-pagination">
      <span>100 chapters per page</span>
      <div class="row-actions">
        <button type="button" class="secondary" id="firstImportPage">First</button>
        <button type="button" class="secondary" id="nextImportPage" ${page.next_after === null ? 'disabled' : ''}>Next</button>
      </div>
    </div>
  </section>`;
}

function importJobView(job: ImportJob): string {
  const inFlight = IN_FLIGHT_IMPORT.includes(job.status);
  const ready = job.status === 'ready';
  const cancellable = ['queued', 'ready', 'failed'].includes(job.status);
  return `
    <section class="toolbar-row">
      <button type="button" class="secondary" id="backToImports">← Import jobs</button>
      ${cancellable ? '<button type="button" class="danger" id="cancelImport">Cancel import</button>' : ''}
    </section>
    <article class="panel">
      <div class="section-heading"><div><p class="eyebrow">Import · ${escapeHtml(job.format)} · ${escapeHtml(job.mode)}</p><h3>${escapeHtml(job.filename)}</h3></div>${importStatusPill(job.status)}</div>
      ${inFlight ? '<p class="muted">Working… this page refreshes every 2 seconds.</p>' : ''}
      ${job.errors.length > 0 ? `<div class="config-warning">${job.errors.map((error) => escapeHtml(error)).join('<br />')}</div>` : ''}
      ${
        job.status === 'done'
          ? `<p>Imported. ${job.result_novel_ids
              .map(
                (novelId) =>
                  `<button type="button" class="secondary" data-import-result="${escapeHtml(novelId)}">Open novel</button>`,
              )
              .join(' ')}</p>`
          : ''
      }
      <dl class="details-grid">
        <dt>Created</dt><dd>${formatDate(job.created_at)}</dd>
        <dt>Finished</dt><dd>${formatDate(job.finished_at)}</dd>
      </dl>
    </article>
    ${
      ready && job.preview
        ? `<form id="commitImportForm" class="form-stack">
      ${importPreviewNovelForm(job)}
      <article class="panel">
        <div class="section-heading"><div><p class="eyebrow">Step 2</p><h3>Confirm</h3></div></div>
        <div class="form-grid">
          <label>Imported chapter status<select name="chapter_status">${optionList(['published', 'draft'], 'published')}</select><small>New novels are created as draft (unless set above), so nothing reaches readers until the novel is published.</small></label>
        </div>
        <div class="form-actions"><button type="submit">Import</button></div>
      </article>
    </form>
    ${importChapterTable()}`
        : ''
    }`;
}

function commitInputFromForm(form: HTMLFormElement, job: ImportJob): CommitImportInput {
  const values = new FormData(form);
  const input: CommitImportInput = {
    chapter_status: String(values.get('chapter_status') ?? 'published') as 'draft' | 'published',
  };
  if (job.mode !== 'new') return input;
  input.novels = [...form.querySelectorAll<HTMLFieldSetElement>('[data-import-novel]')].map(
    (fieldset) => {
      const field = (name: string): string =>
        fieldset
          .querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
            `[name="${name}"]`,
          )
          ?.value.trim() ?? '';
      const index = Number(fieldset.dataset['importNovel']);
      if (fieldset.querySelector<HTMLInputElement>('[name="skip"]')?.checked)
        return { index, skip: true };
      return {
        index,
        title: field('title'),
        author: field('author') || null,
        description: field('description') || null,
        ...(field('language') ? { language: field('language') } : {}),
        tags: splitValues(field('tags')),
        status: field('status') as 'draft' | 'published' | 'hidden',
        category_ids: [
          ...fieldset.querySelectorAll<HTMLInputElement>('[name="category_ids"]:checked'),
        ].map((input) => input.value),
      };
    },
  );
  return input;
}

function wireImportJob(job: ImportJob): void {
  document.querySelector<HTMLButtonElement>('#backToImports')?.addEventListener('click', () => {
    ns.importJob = null;
    ns.importChapters = null;
    void run(async () => {
      ns.imports = (await listImportJobs()).items;
    });
  });
  document.querySelector<HTMLButtonElement>('#cancelImport')?.addEventListener('click', () => {
    if (!window.confirm('Cancel this import? Parsed chapters are discarded.')) return;
    void run(async () => {
      ns.importJob = await cancelImportJob(job.id);
      ns.importChapters = null;
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-import-preview]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset['importPreview']);
      void run(async () => {
        ns.importNovelIndex = index;
        ns.importChapters = await listImportChapters(job.id, { novel_index: index });
      });
    });
  });
  document.querySelector<HTMLButtonElement>('#nextImportPage')?.addEventListener('click', () => {
    const after = ns.importChapters?.next_after;
    if (after === null || after === undefined) return;
    void run(async () => {
      ns.importChapters = await listImportChapters(job.id, {
        novel_index: ns.importNovelIndex,
        after,
      });
    });
  });
  document.querySelector<HTMLButtonElement>('#firstImportPage')?.addEventListener('click', () => {
    void run(async () => {
      ns.importChapters = await listImportChapters(job.id, { novel_index: ns.importNovelIndex });
    });
  });
  document
    .querySelector<HTMLFormElement>('#commitImportForm')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = commitInputFromForm(event.currentTarget as HTMLFormElement, job);
      void run(async () => {
        ns.importJob = await commitImportJob(job.id, input);
        ns.importChapters = null;
      });
    });
  document.querySelectorAll<HTMLButtonElement>('[data-import-result]').forEach((button) => {
    button.addEventListener('click', () => {
      ns.tab = 'novels';
      ns.importJob = null;
      void openNovel(button.dataset['importResult'] ?? '');
    });
  });
}

// ---- Categories ----

function categoriesView(): string {
  const categories = ns.categories ?? [];
  const editable = canEdit();
  return `
    ${
      editable
        ? `<article class="panel">
      <div class="section-heading"><div><p class="eyebrow">New</p><h3>Add category</h3></div></div>
      <form id="categoryCreate" class="inline-form category-form">
        <input name="name" placeholder="Name" maxlength="80" required />
        <input name="slug" placeholder="slug (optional)" pattern="[a-z0-9-]{1,80}" />
        <input name="sort_order" type="number" step="1" value="0" title="Sort order" />
        <button type="submit">Add</button>
      </form>
    </article>`
        : ''
    }
    <section class="panel table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Slug</th><th>Order</th><th>Novels</th><th>Active</th><th></th></tr></thead>
        <tbody>${
          categories.length > 0
            ? categories
                .map(
                  (category) => `<tr>
              <td><input form="category-${escapeHtml(category.id)}" name="name" value="${escapeHtml(category.name)}" maxlength="80" required ${editable ? '' : 'disabled'} /></td>
              <td><input form="category-${escapeHtml(category.id)}" name="slug" value="${escapeHtml(category.slug)}" pattern="[a-z0-9-]{1,80}" ${editable ? '' : 'disabled'} /></td>
              <td><input form="category-${escapeHtml(category.id)}" name="sort_order" type="number" step="1" value="${category.sort_order}" ${editable ? '' : 'disabled'} /></td>
              <td>${integer(category.novel_count)}</td>
              <td class="select-cell"><input form="category-${escapeHtml(category.id)}" name="is_active" type="checkbox" ${category.is_active ? 'checked' : ''} ${editable ? '' : 'disabled'} /></td>
              <td class="row-actions">${
                editable
                  ? `<form id="category-${escapeHtml(category.id)}" data-category-form="${escapeHtml(category.id)}"></form>
                <button type="submit" form="category-${escapeHtml(category.id)}" class="secondary">Save</button>
                <button type="button" class="subtle" data-category-delete="${escapeHtml(category.id)}">Delete</button>`
                  : ''
              }</td>
            </tr>`,
                )
                .join('')
            : '<tr><td colspan="6" class="empty-state">No categories yet.</td></tr>'
        }</tbody>
      </table>
    </section>`;
}

function wireCategories(): void {
  document
    .querySelector<HTMLFormElement>('#categoryCreate')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget as HTMLFormElement);
      const slug = String(values.get('slug') ?? '').trim();
      void run(async () => {
        await createNovelCategory({
          name: String(values.get('name') ?? '').trim(),
          ...(slug ? { slug } : {}),
          sort_order: Number(values.get('sort_order') ?? 0),
        });
        ns.categories = (await listNovelCategories()).items;
      });
    });
  document.querySelectorAll<HTMLFormElement>('[data-category-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const categoryId = form.dataset['categoryForm'] ?? '';
      const values = new FormData(form);
      const slug = String(values.get('slug') ?? '').trim();
      void run(async () => {
        await updateNovelCategory(categoryId, {
          name: String(values.get('name') ?? '').trim(),
          ...(slug ? { slug } : {}),
          sort_order: Number(values.get('sort_order') ?? 0),
          is_active: values.get('is_active') === 'on',
        });
        ns.categories = (await listNovelCategories()).items;
      });
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-category-delete]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!window.confirm('Delete this category? Novels keep their other categories.')) return;
      const categoryId = button.dataset['categoryDelete'] ?? '';
      void run(async () => {
        await deleteNovelCategory(categoryId);
        ns.categories = (await listNovelCategories()).items;
      });
    });
  });
}

// ---- Top novels ----

function topView(): string {
  const items = ns.top?.items ?? [];
  return `
    <section class="toolbar-row">
      <form id="topFilter" class="inline-form">
        <select name="days">${[7, 30, 90, 365]
          .map(
            (days) =>
              `<option value="${days}" ${ns.statsDays === days ? 'selected' : ''}>Last ${days} days</option>`,
          )
          .join('')}</select>
        <button type="submit">Apply</button>
      </form>
    </section>
    <section class="panel table-wrap">
      <table>
        <thead><tr><th>Novel</th><th>Readers</th><th>Completions</th><th>Coin rewarded</th><th>Coin spent on unlocks</th><th></th></tr></thead>
        <tbody>${
          items.length > 0
            ? items
                .map(
                  (item) => `<tr>
              <td><strong>${escapeHtml(item.title)}</strong></td>
              <td>${integer(item.readers)}</td>
              <td>${integer(item.completions)}</td>
              <td>${integer(item.coin_rewarded)}</td>
              <td>${integer(item.coin_spent)}</td>
              <td class="row-actions"><button class="secondary" data-top-open="${escapeHtml(item.novel_id)}">Open</button></td>
            </tr>`,
                )
                .join('')
            : '<tr><td colspan="6" class="empty-state">No reading activity in this window.</td></tr>'
        }</tbody>
      </table>
    </section>`;
}

function wireTop(): void {
  document.querySelector<HTMLFormElement>('#topFilter')?.addEventListener('submit', (event) => {
    event.preventDefault();
    ns.statsDays = Number(new FormData(event.currentTarget as HTMLFormElement).get('days') ?? 30);
    void run(async () => {
      ns.top = await getTopNovels(ns.statsDays);
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-top-open]').forEach((button) => {
    button.addEventListener('click', () => {
      ns.tab = 'novels';
      void openNovel(button.dataset['topOpen'] ?? '');
    });
  });
}
