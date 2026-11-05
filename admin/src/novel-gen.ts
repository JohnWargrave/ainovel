// The "AI Studio" tab of the Novels page: idea → story bible → outline → chapters, each step an AI
// task the editor reviews and edits before the next. Rendered by novels.ts through StudioHost so
// this module never imports it back.
import type { AdminCategory } from './novels-api.js';
import {
  createGenProject,
  deleteGenProject,
  generateGenOutline,
  getGenProject,
  listGenProjects,
  regenerateGenBible,
  regenerateGenOutlineChapter,
  saveGenBible,
  saveGenOutline,
  startGenWriting,
  stopGenProject,
  type GenProject,
  type GenProjectSummary,
  type OutlineChapter,
  type StoryBible,
  type StoryCharacter,
  type StoryOutline,
} from './novel-gen-api.js';
import { errorMessage, escapeHtml, formatDate, integer } from './format.js';
import {
  aiSettingsPanel,
  currentAiSettings,
  estimateChaptersUsd,
  loadAiSettingsPanel,
  modelOptions,
  usd,
  wireAiSettingsPanel,
  type AiSettingsHost,
} from './ai-settings.js';

export interface StudioHost {
  // Same contract as novels.ts' run(): loading banner, errors land in the error banner.
  run<T>(action: () => Promise<T>, after?: (value: T) => void | Promise<void>): Promise<void>;
  rerender(): void;
  setError(message: string): void;
  // The Novels page is showing and the AI Studio tab is open.
  isActive(): boolean;
  categories(): AdminCategory[];
  openNovel(novelId: string): void;
  role(): string | undefined;
}

type Step = 'bible' | 'outline' | 'write';

interface StudioState {
  list: GenProjectSummary[] | null;
  project: GenProject | null;
  step: Step;
  // Working copies the editor types into; the server's copy replaces them only while clean.
  bible: StoryBible | null;
  bibleDirty: boolean;
  outline: StoryOutline | null;
  outlineDirty: boolean;
}

const LANGUAGES: Array<[string, string]> = [
  ['vi', 'Vietnamese'],
  ['en', 'English'],
  ['id', 'Indonesian'],
  ['th', 'Thai'],
  ['ms', 'Malay'],
  ['tl', 'Filipino'],
  ['es', 'Spanish'],
  ['pt', 'Portuguese'],
];

const STATUS_PILL: Record<string, string> = {
  queued: 'queued',
  running: 'parsing',
  idle: 'done',
  paused: 'ready',
  failed: 'failed',
  stalled: 'failed',
};

const TASK_LABEL: Record<string, string> = {
  bible: 'Story bible',
  outline: 'Outline',
  outline_chapter: 'Chapter outline',
  chapters: 'Writing chapters',
};

const POLL_MS = 2000;

let st: StudioState = initialState();
let h: StudioHost | null = null;
let pollTimer: number | undefined;

function initialState(): StudioState {
  return {
    list: null,
    project: null,
    step: 'bible',
    bible: null,
    bibleDirty: false,
    outline: null,
    outlineDirty: false,
  };
}

export function resetStudio(): void {
  window.clearTimeout(pollTimer);
  st = initialState();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function defaultStep(project: GenProject): Step {
  if (!project.bible || project.task === 'bible') return 'bible';
  if (!project.outline || project.task === 'outline' || project.task === 'outline_chapter') {
    return 'outline';
  }
  return 'write';
}

function applyProject(project: GenProject): void {
  st.project = project;
  if (!st.bibleDirty) st.bible = project.bible ? clone(project.bible) : null;
  if (!st.outlineDirty) st.outline = project.outline ? clone(project.outline) : null;
}

// A task the worker stopped answering for (it died) shows as stalled; it can be started again.
function displayStatus(project: GenProjectSummary): string {
  if (project.busy) return project.status;
  return project.status === 'queued' || project.status === 'running' ? 'stalled' : project.status;
}

function pill(status: string): string {
  return `<span class="pill import-status-${STATUS_PILL[status] ?? 'queued'}">${escapeHtml(status)}</span>`;
}

// ---- Loading ----

export async function loadStudio(host: StudioHost): Promise<void> {
  h = host;
  window.clearTimeout(pollTimer);
  st.project = null;
  await host.run(async () => {
    const [list] = await Promise.all([listGenProjects(), loadAiSettingsPanel(settingsHost())]);
    st.list = list.items;
  });
}

function settingsHost(): AiSettingsHost {
  return {
    run: (action, after) => h?.run(action, after) ?? Promise.resolve(),
    rerender: () => h?.rerender(),
    setError: (message) => h?.setError(message),
    isSuperadmin: () => h?.role() === 'superadmin',
  };
}

function defaultModel(): string {
  return currentAiSettings()?.novel_model ?? '';
}

async function openProject(projectId: string): Promise<void> {
  await h?.run(async () => {
    const project = await getGenProject(projectId);
    st.bibleDirty = false;
    st.outlineDirty = false;
    applyProject(project);
    st.step = defaultStep(project);
  });
}

// While a task runs, poll; a tick that only moved the progress line or the streamed text updates
// those two elements in place, so the page (and whatever the editor is reading) doesn't jump.
function schedulePoll(): void {
  window.clearTimeout(pollTimer);
  const project = st.project;
  if (!project?.busy) return;
  pollTimer = window.setTimeout(() => {
    if (!h?.isActive() || st.project?.id !== project.id) return;
    void getGenProject(project.id)
      .then((next) => {
        const quiet =
          next.busy &&
          next.status === project.status &&
          next.task === project.task &&
          next.written.length === project.written.length &&
          next.live_chapter_no === project.live_chapter_no;
        applyProject(next);
        if (quiet && updateLive(next)) {
          schedulePoll();
          return;
        }
        h?.rerender();
      })
      .catch((error: unknown) => h?.setError(errorMessage(error)));
  }, POLL_MS);
}

function updateLive(project: GenProject): boolean {
  const progress = document.querySelector<HTMLElement>('#genProgress');
  if (!progress) return false;
  progress.textContent = project.progress ?? '';
  const live = document.querySelector<HTMLElement>('#genLive');
  if (live) {
    const atBottom = live.scrollHeight - live.scrollTop - live.clientHeight < 40;
    live.textContent = project.live_text ?? '';
    if (atBottom) live.scrollTop = live.scrollHeight;
  }
  const words = document.querySelector<HTMLElement>('#genLiveWords');
  if (words) words.textContent = `${integer(wordCount(project.live_text ?? ''))} words so far`;
  return true;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

// ---- Rendering ----

export function studioView(): string {
  return st.project ? projectView(st.project) : listView();
}

function listView(): string {
  const categories = h?.categories() ?? [];
  const items = st.list ?? [];
  return `
    ${aiSettingsPanel()}
    <article class="panel">
      <div class="section-heading"><div><p class="eyebrow">Step 1 · Idea</p><h3>Generate a novel with AI</h3></div></div>
      <form id="genCreateForm" class="form-grid">
        <label class="field-wide">Idea
          <textarea name="idea" rows="5" minlength="10" maxlength="4000" required placeholder="Premise, protagonist, the hook, how it should end… The more specific, the better the story bible."></textarea>
        </label>
        <label>Title<input name="title" maxlength="300" placeholder="Empty: the AI suggests one" /></label>
        <label>Language<select name="language">${LANGUAGES.map(([code, name]) => `<option value="${code}">${escapeHtml(name)}</option>`).join('')}</select></label>
        <label>Tone and style<input name="tone" maxlength="500" placeholder="e.g. fast-paced, humorous, first person" /></label>
        <label>Target readers<input name="audience" maxlength="500" placeholder="e.g. young adult men who like cultivation" /></label>
        <label>Chapters<input name="chapter_count" type="number" min="1" max="1000" step="1" value="30" required /></label>
        <label>Words per chapter<input name="words_per_chapter" type="number" min="300" max="5000" step="100" value="2000" required /></label>
        <label class="field-wide">AI model<select name="model">${modelOptions(defaultModel())}</select><small>Prices from the DeepSeek settings above; you can switch before writing chapters.</small></label>
        <fieldset class="check-group field-wide">
          <legend>Genres</legend>
          ${
            categories.length > 0
              ? categories
                  .map(
                    (category) =>
                      `<label class="check-label"><input type="checkbox" name="category_ids" value="${escapeHtml(category.id)}" /> ${escapeHtml(category.name)}</label>`,
                  )
                  .join('')
              : '<span class="muted">No categories yet.</span>'
          }
        </fieldset>
        <label class="switch-label field-wide"><input type="checkbox" name="auto_cover" checked /> Generate an AI cover when the novel is created</label>
        <div class="form-actions field-wide"><button type="submit">Write the story bible</button><span class="muted">Runs in the background (about a minute). Nothing is published: chapters are saved as drafts.</span></div>
      </form>
    </article>
    <section class="panel table-wrap">
      <div class="section-heading"><div><p class="eyebrow">Projects</p><h3>AI novels</h3></div><button type="button" class="secondary" id="genRefresh">Refresh</button></div>
      <table>
        <thead><tr><th>Title</th><th>Status</th><th>Step</th><th>Chapters</th><th>Updated</th><th></th></tr></thead>
        <tbody>${
          items.length > 0
            ? items
                .map(
                  (item) => `<tr>
              <td><strong>${escapeHtml(item.title)}</strong></td>
              <td>${pill(displayStatus(item))}${item.progress && item.busy ? `<small>${escapeHtml(item.progress)}</small>` : ''}</td>
              <td>${escapeHtml(TASK_LABEL[item.task] ?? item.task)}</td>
              <td>${item.planned_chapters > 0 ? integer(item.planned_chapters) : '—'}</td>
              <td>${formatDate(item.updated_at)}</td>
              <td class="row-actions"><button class="secondary" data-gen-open="${escapeHtml(item.id)}">Open</button></td>
            </tr>`,
                )
                .join('')
            : '<tr><td colspan="6" class="empty-state">No AI novels yet.</td></tr>'
        }</tbody>
      </table>
    </section>`;
}

function projectView(project: GenProject): string {
  const steps: Array<[Step, string, boolean]> = [
    ['bible', '2 · Story bible', true],
    ['outline', '3 · Outline', project.bible !== null],
    ['write', '4 · Chapters', project.outline !== null],
  ];
  let body = '';
  if (st.step === 'bible') body = bibleView(project);
  if (st.step === 'outline') body = outlineView(project);
  if (st.step === 'write') body = writeView(project);
  return `
    <section class="toolbar-row">
      <button type="button" class="secondary" id="genBack">← AI novels</button>
      ${project.novel_id ? `<button type="button" class="secondary" id="genOpenNovel">Open the novel</button>` : ''}
    </section>
    <article class="panel">
      <div class="section-heading">
        <div><p class="eyebrow">AI novel</p><h3>${escapeHtml(project.title)}</h3></div>
        <div class="row-actions">
          ${project.busy ? `<button type="button" class="danger" id="genStop">${project.task === 'chapters' ? 'Pause' : 'Stop'}</button>` : `<button type="button" class="secondary danger" id="genDelete">Delete project</button>`}
        </div>
      </div>
      <div class="gen-status">
        ${pill(displayStatus(project))}
        <strong>${escapeHtml(TASK_LABEL[project.task] ?? project.task)}</strong>
        <span id="genProgress" class="muted">${escapeHtml(project.busy ? (project.progress ?? '') : '')}</span>
        <small class="muted gen-usage"><strong>${escapeHtml(usd(project.cost_usd))}</strong> spent · ${integer(project.prompt_tokens)} in / ${integer(project.completion_tokens)} out tokens${project.model ? ` · ${escapeHtml(project.model)}` : ''}</small>
      </div>
      ${displayStatus(project) === 'stalled' ? '<p class="cover-ai-error">The AI worker stopped answering; start the step again.</p>' : ''}
      ${project.errors.length > 0 ? `<ul class="gen-errors">${project.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>` : ''}
      <details class="gen-idea"><summary>1 · Idea</summary>
        <p>${escapeHtml(project.input.idea)}</p>
        <small class="muted">${[
          project.input.genres.join(', '),
          LANGUAGES.find(([code]) => code === project.input.language)?.[1] ??
            project.input.language,
          project.input.tone,
          project.input.audience,
          `${integer(project.input.chapter_count)} chapters × ~${integer(project.input.words_per_chapter)} words`,
        ]
          .filter((part) => part)
          .map(escapeHtml)
          .join(' · ')}</small>
      </details>
    </article>
    <div class="tab-bar gen-steps">${steps
      .map(
        ([step, label, enabled]) =>
          `<button class="tab-button ${st.step === step ? 'active' : ''}" type="button" data-gen-step="${step}" ${enabled ? '' : 'disabled'}>${label}</button>`,
      )
      .join('')}</div>
    ${body}`;
}

function waiting(message: string): string {
  return `<article class="panel gen-waiting"><p>${escapeHtml(message)}</p><small class="muted">You can leave this page; the work continues in the background.</small></article>`;
}

function bibleView(project: GenProject): string {
  const bible = st.bible;
  if (!bible) {
    return project.busy
      ? waiting('The AI is writing the story bible…')
      : `<article class="panel"><p>No story bible yet.</p><div class="form-actions"><button type="button" id="genRegenBible">Write the story bible</button></div></article>`;
  }
  const locked = project.busy ? 'disabled' : '';
  const text = (field: keyof StoryBible, label: string, rows = 0, wide = false): string => {
    const value = escapeHtml(bible[field] as string);
    const input =
      rows > 0
        ? `<textarea data-bible="${field}" rows="${String(rows)}" maxlength="4000">${value}</textarea>`
        : `<input data-bible="${field}" value="${value}" maxlength="${field === 'title' ? '300' : '500'}" />`;
    return `<label class="${wide ? 'field-wide' : ''}">${label}${input}</label>`;
  };
  return `
    <article class="panel">
      <div class="section-heading"><div><p class="eyebrow">Step 2</p><h3>Story bible</h3></div><span id="bibleDirty" class="muted">${st.bibleDirty ? 'Unsaved changes' : ''}</span></div>
      <fieldset class="form-grid novel-fieldset" ${locked}>
        ${text('title', 'Title')}
        ${text('logline', 'Logline')}
        ${text('description', 'Description (shown to readers)', 5, true)}
        ${text('setting', 'Setting', 3)}
        ${text('world_rules', 'World rules', 3)}
        ${text('tone', 'Tone and style')}
        <label>Themes<input data-bible-list="themes" value="${escapeHtml(bible.themes.join(', '))}" /><small>Comma separated.</small></label>
        <label class="field-wide">Tags<input data-bible-list="tags" value="${escapeHtml(bible.tags.join(', '))}" /><small>Comma separated; they become the novel's tags.</small></label>
      </fieldset>
      <h4>Characters</h4>
      <fieldset class="gen-characters" ${locked}>
        ${bible.characters.map((character, index) => characterCard(character, index)).join('')}
        <button type="button" class="secondary" id="genAddCharacter">+ Add character</button>
      </fieldset>
      <div class="form-actions">
        <button type="button" id="genSaveBible" ${st.bibleDirty && !project.busy ? '' : 'disabled'}>Save bible</button>
        <button type="button" class="secondary" data-gen-step="outline" ${project.outline || !project.busy ? '' : 'disabled'}>Continue to the outline →</button>
      </div>
      ${project.novel_id ? '<p class="muted">The novel already exists: later bible edits guide the next chapters but do not change the novel page; edit it in the Novels tab.</p>' : ''}
    </article>
    <article class="panel">
      <div class="section-heading"><div><p class="eyebrow">AI</p><h3>Rewrite the bible</h3></div></div>
      <label class="form-stack">Instructions for the AI<textarea id="genBibleNote" rows="3" maxlength="2000" placeholder="e.g. make the heroine a rival first, add a mentor with a secret" ${locked}></textarea></label>
      <div class="form-actions"><button type="button" class="secondary" id="genRegenBible" ${locked}>Regenerate the bible</button><span class="muted">Keeps what you don't ask to change.</span></div>
    </article>`;
}

function characterCard(character: StoryCharacter, index: number): string {
  const field = (name: keyof StoryCharacter, label: string, rows = 0): string => {
    const value = escapeHtml(character[name]);
    const key = `${String(index)}:${name}`;
    return `<label>${label}${
      rows > 0
        ? `<textarea data-char="${key}" rows="${String(rows)}" maxlength="${name === 'description' ? '4000' : '500'}">${value}</textarea>`
        : `<input data-char="${key}" value="${value}" maxlength="80" />`
    }</label>`;
  };
  return `<div class="gen-character">
      <div class="gen-character-head">${field('name', 'Name')}${field('role', 'Role')}<button type="button" class="secondary danger" data-char-remove="${String(index)}" title="Remove">✕</button></div>
      ${field('description', 'Description', 2)}
      ${field('goal', 'Goal', 1)}
      ${field('relationships', 'Relationships', 1)}
    </div>`;
}

function outlineView(project: GenProject): string {
  const outline = st.outline;
  const locked = project.busy ? 'disabled' : '';
  const generator = `
    <article class="panel">
      <div class="section-heading"><div><p class="eyebrow">AI</p><h3>${outline ? 'Regenerate the outline' : 'Generate the outline'}</h3></div></div>
      <div class="form-grid">
        <label>Chapters<input id="genOutlineCount" type="number" min="1" max="1000" step="1" value="${String(outline?.chapters.length ?? project.input.chapter_count)}" ${locked} /></label>
        <label class="field-wide">Instructions for the AI<textarea id="genOutlineNote" rows="2" maxlength="2000" placeholder="e.g. a betrayal around chapter 10, slow-burn romance" ${locked}></textarea></label>
      </div>
      <div class="form-actions"><button type="button" ${outline ? 'class="secondary"' : ''} id="genGenerateOutline" ${locked}>${outline ? 'Regenerate the outline' : 'Generate the outline'}</button><span class="muted">${outline ? 'Locked chapters are kept as they are.' : 'Arcs first, then chapter beats in batches of 15.'}</span></div>
    </article>`;
  if (!outline) {
    return project.busy && project.task === 'outline'
      ? waiting(project.progress ?? 'The AI is outlining…')
      : generator;
  }
  const written = new Set(project.written.map((chapter) => chapter.chapter_no));
  return `
    ${project.busy && project.task !== 'chapters' ? waiting(project.progress ?? 'The AI is working on the outline…') : ''}
    <article class="panel">
      <div class="section-heading"><div><p class="eyebrow">Step 3</p><h3>Arcs</h3></div><span id="outlineDirty" class="muted">${st.outlineDirty ? 'Unsaved changes' : ''}</span></div>
      <fieldset class="gen-arcs" ${locked}>
        ${outline.arcs
          .map(
            (arc, index) => `<div class="gen-arc">
            <input data-arc="${String(index)}:title" value="${escapeHtml(arc.title)}" maxlength="300" aria-label="Arc title" />
            <label class="gen-arc-range">Ch. <input data-arc="${String(index)}:from_chapter" type="number" min="1" value="${String(arc.from_chapter)}" /> – <input data-arc="${String(index)}:to_chapter" type="number" min="1" value="${String(arc.to_chapter)}" /></label>
            <button type="button" class="secondary danger" data-arc-remove="${String(index)}" title="Remove">✕</button>
            <textarea data-arc="${String(index)}:summary" rows="2" maxlength="4000" aria-label="Arc summary">${escapeHtml(arc.summary)}</textarea>
          </div>`,
          )
          .join('')}
        <button type="button" class="secondary" id="genAddArc">+ Add arc</button>
      </fieldset>
    </article>
    <article class="panel table-wrap">
      <div class="section-heading"><div><p class="eyebrow">Step 3</p><h3>Chapters (${integer(outline.chapters.length)})</h3></div>
        <div class="row-actions"><button type="button" id="genSaveOutline" ${st.outlineDirty && !project.busy ? '' : 'disabled'}>Save outline</button><button type="button" class="secondary" data-gen-step="write">Continue to writing →</button></div>
      </div>
      <fieldset class="gen-outline" ${locked}>
        <table>
          <thead><tr><th>#</th><th>Title and beats (one per line)</th><th>Lock</th><th></th></tr></thead>
          <tbody>${outline.chapters.map((chapter, index) => outlineRow(chapter, index, outline.chapters.length, written.has(chapter.no), project)).join('')}</tbody>
        </table>
        <button type="button" class="secondary" id="genAddChapter">+ Add chapter</button>
      </fieldset>
    </article>
    ${generator}`;
}

function outlineRow(
  chapter: OutlineChapter,
  index: number,
  total: number,
  isWritten: boolean,
  project: GenProject,
): string {
  const key = String(index);
  const rewriting =
    project.busy && project.task === 'outline_chapter' && project.task_chapter_no === chapter.no;
  return `<tr class="${rewriting ? 'gen-row-busy' : ''}">
      <td><strong>${String(chapter.no)}</strong>${isWritten ? '<small class="pill import-status-done">written</small>' : ''}</td>
      <td class="gen-outline-cell">
        <input data-ch="${key}:title" value="${escapeHtml(chapter.title)}" maxlength="300" aria-label="Chapter ${String(chapter.no)} title" />
        <textarea data-ch="${key}:beats" rows="${String(Math.max(2, chapter.beats.length))}" aria-label="Chapter ${String(chapter.no)} beats">${escapeHtml(chapter.beats.join('\n'))}</textarea>
      </td>
      <td><input type="checkbox" data-ch-lock="${key}" ${chapter.locked ? 'checked' : ''} aria-label="Lock chapter ${String(chapter.no)}" /></td>
      <td class="row-actions gen-row-actions">
        <button type="button" class="secondary" data-ch-move="${key}:-1" ${index === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button type="button" class="secondary" data-ch-move="${key}:1" ${index === total - 1 ? 'disabled' : ''} title="Move down">↓</button>
        <button type="button" class="secondary" data-ch-ai="${key}" ${chapter.locked ? 'disabled' : ''} title="Let the AI rewrite this chapter's outline">${rewriting ? 'Rewriting…' : 'AI rewrite'}</button>
        <button type="button" class="secondary danger" data-ch-remove="${key}" title="Remove">✕</button>
      </td>
    </tr>`;
}

function writeView(project: GenProject): string {
  const chapters = project.outline?.chapters ?? [];
  const written = new Map(project.written.map((chapter) => [chapter.chapter_no, chapter]));
  const firstMissing = chapters.find((chapter) => !written.has(chapter.no))?.no;
  const writing = project.busy && project.task === 'chapters';
  const count = chapters.filter((chapter) => written.has(chapter.no)).length;
  const words = project.written.reduce((sum, chapter) => sum + chapter.word_count, 0);
  const canResume =
    !project.busy &&
    project.task === 'chapters' &&
    (project.status === 'paused' || project.status === 'failed') &&
    project.write_next !== null &&
    project.write_to !== null &&
    project.write_next <= project.write_to;
  return `
    <article class="panel">
      <div class="section-heading"><div><p class="eyebrow">Step 4</p><h3>Chapters · ${integer(count)} of ${integer(chapters.length)} written</h3></div>
        <small class="muted">${integer(words)} words in total</small>
      </div>
      <div class="gen-chips">${chapters
        .map((chapter) => {
          const state =
            project.live_chapter_no === chapter.no && writing
              ? 'live'
              : written.has(chapter.no)
                ? 'written'
                : 'pending';
          return `<span class="gen-chip gen-chip-${state}" title="${escapeHtml(`${String(chapter.no)}. ${chapter.title}`)}">${String(chapter.no)}</span>`;
        })
        .join('')}</div>
      ${st.outlineDirty ? '<p class="cover-ai-error">The outline has unsaved changes; save it before writing.</p>' : ''}
      <form id="genWriteForm" class="form-grid">
        <fieldset class="field-wide form-grid novel-fieldset" ${project.busy ? 'disabled' : ''}>
          <label>From chapter<input name="from" type="number" min="1" max="${String(chapters.length)}" step="1" value="${String(firstMissing ?? 1)}" required /></label>
          <label>To chapter<input name="to" type="number" min="1" max="${String(chapters.length)}" step="1" value="${String(chapters.length)}" required /></label>
          <label>Words per chapter<input name="words_per_chapter" type="number" min="300" max="5000" step="100" value="${String(project.input.words_per_chapter)}" /></label>
          <label>AI model<select name="model">${modelOptions(project.model ?? defaultModel())}</select></label>
          <p class="field-wide muted" id="genEstimate"></p>
          <label class="check-label"><input type="checkbox" name="overwrite" ${firstMissing === undefined ? 'checked' : ''} /> Rewrite chapters that already exist (the old text is kept as a revision)</label>
        </fieldset>
        <div class="form-actions field-wide">
          ${
            writing
              ? '<span class="muted">Writing…</span>'
              : `<button type="submit" ${project.busy || st.outlineDirty ? 'disabled' : ''}>${project.novel_id ? 'Write chapters' : 'Create the novel and write'}</button>
                 ${canResume ? `<button type="button" class="secondary" id="genResume">Resume at chapter ${String(project.write_next)}</button>` : ''}`
          }
          <span class="muted">One chapter at a time, each with the end of the previous one as context. Chapters are saved as <strong>drafts</strong>: review and publish them in the Novels tab.</span>
        </div>
      </form>
    </article>
    ${
      writing
        ? `<article class="panel">
      <div class="section-heading"><div><p class="eyebrow">Live</p><h3>Chapter ${String(project.live_chapter_no ?? project.write_next ?? '')}</h3></div><small id="genLiveWords" class="muted">${integer(wordCount(project.live_text ?? ''))} words so far</small></div>
      <pre id="genLive" class="gen-live">${escapeHtml(project.live_text ?? '')}</pre>
    </article>`
        : ''
    }`;
}

// ---- Wiring ----

function on<T extends HTMLElement>(
  selector: string,
  event: string,
  handler: (element: T) => void,
): void {
  document.querySelectorAll<T>(selector).forEach((element) => {
    element.addEventListener(event, () => {
      handler(element);
    });
  });
}

function markDirty(kind: 'bible' | 'outline'): void {
  if (kind === 'bible') st.bibleDirty = true;
  else st.outlineDirty = true;
  const label = document.querySelector<HTMLElement>(
    kind === 'bible' ? '#bibleDirty' : '#outlineDirty',
  );
  if (label) label.textContent = 'Unsaved changes';
  const save = document.querySelector<HTMLButtonElement>(
    kind === 'bible' ? '#genSaveBible' : '#genSaveOutline',
  );
  if (save) save.disabled = false;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function confirmDiscard(kind: 'bible' | 'outline'): boolean {
  const dirty = kind === 'bible' ? st.bibleDirty : st.outlineDirty;
  return !dirty || window.confirm(`Discard your unsaved ${kind} changes?`);
}

// Starts an AI task and shows its result as it arrives.
function startTask(action: () => Promise<GenProject>): void {
  void h?.run(action, (project) => {
    applyProject(project);
  });
}

export function wireStudio(host: StudioHost): void {
  h = host;
  if (st.project) wireProject(st.project);
  else {
    wireAiSettingsPanel();
    wireList();
  }
  schedulePoll();
}

function wireList(): void {
  document.querySelector<HTMLFormElement>('#genCreateForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    const text = (key: string): string => String(values.get(key) ?? '').trim();
    void h?.run(async () => {
      const project = await createGenProject({
        idea: text('idea'),
        ...(text('title') ? { title: text('title') } : {}),
        language: text('language') || 'vi',
        ...(text('tone') ? { tone: text('tone') } : {}),
        ...(text('audience') ? { audience: text('audience') } : {}),
        chapter_count: Number(text('chapter_count')),
        words_per_chapter: Number(text('words_per_chapter')),
        category_ids: values.getAll('category_ids').map(String),
        auto_cover: values.get('auto_cover') === 'on',
        ...(text('model') ? { model: text('model') } : {}),
      });
      st.bibleDirty = false;
      st.outlineDirty = false;
      applyProject(project);
      st.step = 'bible';
    });
  });
  document.querySelector('#genRefresh')?.addEventListener('click', () => {
    void h?.run(async () => {
      st.list = (await listGenProjects()).items;
    });
  });
  on<HTMLButtonElement>('[data-gen-open]', 'click', (button) => {
    void openProject(button.dataset['genOpen'] ?? '');
  });
}

function wireProject(project: GenProject): void {
  document.querySelector('#genBack')?.addEventListener('click', () => {
    if (!confirmDiscard('bible') || !confirmDiscard('outline')) return;
    if (h) void loadStudio(h);
  });
  document.querySelector('#genOpenNovel')?.addEventListener('click', () => {
    if (project.novel_id) h?.openNovel(project.novel_id);
  });
  document.querySelector('#genStop')?.addEventListener('click', () => {
    startTask(() => stopGenProject(project.id));
  });
  document.querySelector('#genDelete')?.addEventListener('click', () => {
    if (!window.confirm('Delete this AI project? The novel and its chapters stay.')) return;
    void h?.run(async () => {
      await deleteGenProject(project.id);
      st = { ...initialState(), list: (await listGenProjects()).items };
    });
  });
  on<HTMLButtonElement>('[data-gen-step]', 'click', (button) => {
    st.step = button.dataset['genStep'] as Step;
    h?.rerender();
  });
  if (st.step === 'bible') wireBible(project);
  if (st.step === 'outline') wireOutline(project);
  if (st.step === 'write') wireWrite(project);
}

function wireBible(project: GenProject): void {
  on<HTMLInputElement | HTMLTextAreaElement>('[data-bible]', 'input', (element) => {
    if (!st.bible) return;
    const field = element.dataset['bible'] as
      'title' | 'logline' | 'description' | 'setting' | 'world_rules' | 'tone';
    st.bible[field] = element.value;
    markDirty('bible');
  });
  on<HTMLInputElement>('[data-bible-list]', 'input', (element) => {
    if (!st.bible) return;
    st.bible[element.dataset['bibleList'] as 'themes' | 'tags'] = splitList(element.value);
    markDirty('bible');
  });
  on<HTMLInputElement | HTMLTextAreaElement>('[data-char]', 'input', (element) => {
    const [index, field] = (element.dataset['char'] ?? '').split(':');
    const character = st.bible?.characters[Number(index)];
    if (!character || !field) return;
    character[field as keyof StoryCharacter] = element.value;
    markDirty('bible');
  });
  on<HTMLButtonElement>('[data-char-remove]', 'click', (button) => {
    st.bible?.characters.splice(Number(button.dataset['charRemove']), 1);
    st.bibleDirty = true;
    h?.rerender();
  });
  document.querySelector('#genAddCharacter')?.addEventListener('click', () => {
    st.bible?.characters.push({ name: '', role: '', description: '', goal: '', relationships: '' });
    st.bibleDirty = true;
    h?.rerender();
  });
  document.querySelector('#genSaveBible')?.addEventListener('click', () => {
    const bible = st.bible;
    if (!bible) return;
    if (bible.title.trim() === '') {
      h?.setError('The story bible needs a title.');
      return;
    }
    void h?.run(
      () =>
        saveGenBible(project.id, {
          ...bible,
          characters: bible.characters.filter((c) => c.name.trim() !== ''),
        }),
      (saved) => {
        st.bibleDirty = false;
        applyProject(saved);
      },
    );
  });
  document.querySelector('#genRegenBible')?.addEventListener('click', () => {
    if (!confirmDiscard('bible')) return;
    const note = document.querySelector<HTMLTextAreaElement>('#genBibleNote')?.value.trim() ?? '';
    st.bibleDirty = false;
    startTask(() => regenerateGenBible(project.id, note));
  });
}

function wireOutline(project: GenProject): void {
  const outline = st.outline;
  const renumber = (): void => {
    outline?.chapters.forEach((chapter, index) => {
      chapter.no = index + 1;
    });
  };
  on<HTMLInputElement | HTMLTextAreaElement>('[data-ch]', 'input', (element) => {
    const [index, field] = (element.dataset['ch'] ?? '').split(':');
    const chapter = outline?.chapters[Number(index)];
    if (!chapter) return;
    if (field === 'title') chapter.title = element.value;
    if (field === 'beats') {
      chapter.beats = element.value
        .split('\n')
        .map((beat) => beat.trim())
        .filter((beat) => beat !== '');
    }
    markDirty('outline');
  });
  on<HTMLInputElement>('[data-ch-lock]', 'change', (element) => {
    const chapter = outline?.chapters[Number(element.dataset['chLock'])];
    if (!chapter) return;
    chapter.locked = element.checked;
    st.outlineDirty = true;
    h?.rerender();
  });
  on<HTMLButtonElement>('[data-ch-move]', 'click', (button) => {
    const [index, delta] = (button.dataset['chMove'] ?? '').split(':').map(Number);
    if (!outline || index === undefined || delta === undefined) return;
    const target = index + delta;
    const [moved] = outline.chapters.splice(index, 1);
    if (!moved) return;
    outline.chapters.splice(target, 0, moved);
    renumber();
    st.outlineDirty = true;
    h?.rerender();
  });
  on<HTMLButtonElement>('[data-ch-remove]', 'click', (button) => {
    if (!outline || outline.chapters.length <= 1) return;
    outline.chapters.splice(Number(button.dataset['chRemove']), 1);
    renumber();
    st.outlineDirty = true;
    h?.rerender();
  });
  document.querySelector('#genAddChapter')?.addEventListener('click', () => {
    if (!outline) return;
    outline.chapters.push({ no: outline.chapters.length + 1, title: '', beats: [], locked: false });
    st.outlineDirty = true;
    h?.rerender();
  });
  on<HTMLInputElement | HTMLTextAreaElement>('[data-arc]', 'input', (element) => {
    const [index, field] = (element.dataset['arc'] ?? '').split(':');
    const arc = outline?.arcs[Number(index)];
    if (!arc) return;
    if (field === 'title' || field === 'summary') arc[field] = element.value;
    if (field === 'from_chapter' || field === 'to_chapter') arc[field] = Number(element.value);
    markDirty('outline');
  });
  on<HTMLButtonElement>('[data-arc-remove]', 'click', (button) => {
    outline?.arcs.splice(Number(button.dataset['arcRemove']), 1);
    st.outlineDirty = true;
    h?.rerender();
  });
  document.querySelector('#genAddArc')?.addEventListener('click', () => {
    if (!outline) return;
    const last = outline.arcs.at(-1)?.to_chapter ?? 0;
    const end = outline.chapters.length;
    outline.arcs.push({
      title: '',
      summary: '',
      from_chapter: Math.min(last + 1, end),
      to_chapter: end,
    });
    st.outlineDirty = true;
    h?.rerender();
  });

  const save = (): Promise<GenProject> => {
    if (!outline) return Promise.reject(new Error('No outline'));
    // Untitled arcs would be dropped by the server anyway; do it here so the table matches.
    return saveGenOutline(project.id, {
      ...outline,
      arcs: outline.arcs.filter((arc) => arc.title.trim() !== ''),
    }).then((saved) => {
      st.outlineDirty = false;
      return saved;
    });
  };
  document.querySelector('#genSaveOutline')?.addEventListener('click', () => {
    void h?.run(save, (saved) => {
      applyProject(saved);
    });
  });
  on<HTMLButtonElement>('[data-ch-ai]', 'click', (button) => {
    const chapter = outline?.chapters[Number(button.dataset['chAi'])];
    if (!chapter) return;
    const note = window.prompt(
      `Instructions for rewriting chapter ${String(chapter.no)} (optional):`,
      '',
    );
    if (note === null) return;
    // The AI works from the saved outline, so unsaved edits are saved first.
    startTask(async () => {
      if (st.outlineDirty) await save();
      return regenerateGenOutlineChapter(project.id, chapter.no, note.trim());
    });
  });
  document.querySelector('#genGenerateOutline')?.addEventListener('click', () => {
    if (outline && !window.confirm('Regenerate the whole outline? Unlocked chapters are replaced.'))
      return;
    if (!confirmDiscard('outline')) return;
    const count = Number(document.querySelector<HTMLInputElement>('#genOutlineCount')?.value ?? '');
    const note = document.querySelector<HTMLTextAreaElement>('#genOutlineNote')?.value.trim() ?? '';
    st.outlineDirty = false;
    startTask(() =>
      generateGenOutline(project.id, {
        ...(note ? { note } : {}),
        ...(Number.isInteger(count) && count > 0 ? { chapter_count: count } : {}),
      }),
    );
  });
}

function wireWrite(project: GenProject): void {
  const live = document.querySelector<HTMLElement>('#genLive');
  if (live) live.scrollTop = live.scrollHeight;
  const form = document.querySelector<HTMLFormElement>('#genWriteForm');
  const estimate = (): void => {
    const target = document.querySelector<HTMLElement>('#genEstimate');
    if (!form || !target) return;
    const values = new FormData(form);
    const count = Number(values.get('to')) - Number(values.get('from')) + 1;
    const cost = estimateChaptersUsd(
      String(values.get('model') ?? ''),
      count,
      Number(values.get('words_per_chapter')),
    );
    target.textContent =
      cost === null || count <= 0
        ? ''
        : `Rough cost for ${String(count)} chapter${count === 1 ? '' : 's'}: about ${usd(cost)} (prompt cache hits make it cheaper).`;
  };
  form?.addEventListener('input', estimate);
  estimate();
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget as HTMLFormElement);
    const from = Number(values.get('from'));
    const to = Number(values.get('to'));
    const words = Number(values.get('words_per_chapter'));
    const model = String(values.get('model') ?? '');
    const overwrite = values.get('overwrite') === 'on';
    const total = to - from + 1;
    if (
      !window.confirm(
        `Write ${String(total)} chapter${total === 1 ? '' : 's'} with AI (${String(from)}–${String(to)})?`,
      )
    )
      return;
    startTask(() =>
      startGenWriting(project.id, {
        from,
        to,
        overwrite,
        ...(Number.isInteger(words) && words > 0 ? { words_per_chapter: words } : {}),
        ...(model && model !== project.model ? { model } : {}),
      }),
    );
  });
  document.querySelector('#genResume')?.addEventListener('click', () => {
    startTask(() =>
      startGenWriting(project.id, {
        ...(project.write_next !== null ? { from: project.write_next } : {}),
        ...(project.write_to !== null ? { to: project.write_to } : {}),
        overwrite: project.write_overwrite,
      }),
    );
  });
}
