// The Feedback page of the CMS: what readers sent from the app's "Rate the app" screen (read-only)
// and the content reports they filed, which staff resolve or dismiss. Kept out of main.ts like
// novels.ts, which it mirrors: main.ts hands over the shell and status plumbing through FeedbackHost
// so this module never imports main.ts back.
import { api, queryString, type PagedResponse } from './api.js';
import { errorMessage, escapeHtml, formatDate } from './format.js';

export interface FeedbackHost {
  root: HTMLElement;
  shell(content: string): string;
  wireShell(): void;
  setStatus(next: { loading?: boolean; error?: string | null }): void;
  role(): string | undefined;
}

type FeedbackTab = 'feedback' | 'reports';
type ReportStatus = 'open' | 'resolved' | 'dismissed';

interface AppFeedback {
  id: string;
  user_id: string;
  public_id: string;
  rating: number;
  message: string | null;
  email: string | null;
  app_version: string | null;
  created_at: string;
}

interface ContentReport {
  id: string;
  user_id: string;
  public_id: string;
  target_type: 'novel' | 'chapter' | 'app';
  target_id: string | null;
  target_title: string | null;
  novel_id: string | null;
  reason: string;
  message: string | null;
  status: ReportStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

const REASON_LABELS: Record<string, string> = {
  inappropriate: 'Inappropriate',
  copyright: 'Copyright',
  wrong_content: 'Wrong content',
  spam: 'Spam',
  other: 'Other',
};

interface FeedbackState {
  tab: FeedbackTab;
  rating: string;
  reportStatus: string;
  reportTarget: string;
  // Cursors already visited, oldest first — the lists only hand back a forward cursor.
  history: string[];
  cursor: string | undefined;
  feedback: PagedResponse<AppFeedback> | null;
  reports: PagedResponse<ContentReport> | null;
}

let host: FeedbackHost | undefined;
let fs: FeedbackState = initialState();

function initialState(): FeedbackState {
  return {
    tab: 'feedback',
    rating: '',
    reportStatus: 'open',
    reportTarget: '',
    history: [],
    cursor: undefined,
    feedback: null,
    reports: null,
  };
}

// Editors only triage reports; feedback carries reader emails they have no use for.
function canReadFeedback(): boolean {
  return host?.role() !== 'editor';
}

function canResolveReports(): boolean {
  return ['reviewer', 'editor', 'superadmin'].includes(host?.role() ?? '');
}

function listFeedback(): Promise<PagedResponse<AppFeedback>> {
  return api<PagedResponse<AppFeedback>>(
    `/admin/feedback${queryString({ rating: fs.rating, cursor: fs.cursor, limit: 50 })}`,
  );
}

function listReports(): Promise<PagedResponse<ContentReport>> {
  const query = queryString({
    status: fs.reportStatus,
    target_type: fs.reportTarget,
    cursor: fs.cursor,
    limit: 50,
  });
  return api<PagedResponse<ContentReport>>(`/admin/reports${query}`);
}

function setReportStatus(id: string, status: ReportStatus): Promise<ContentReport> {
  return api<ContentReport>(`/admin/reports/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

async function run(action: () => Promise<void>): Promise<void> {
  host?.setStatus({ loading: true, error: null });
  try {
    await action();
    host?.setStatus({ loading: false });
  } catch (error) {
    host?.setStatus({ loading: false, error: errorMessage(error) });
  }
}

function reload(): Promise<void> {
  return run(async () => {
    if (fs.tab === 'reports') fs.reports = await listReports();
    else fs.feedback = await listFeedback();
  });
}

export function resetFeedbackState(): void {
  fs = initialState();
}

export async function loadFeedbackPage(nextHost: FeedbackHost): Promise<void> {
  host = nextHost;
  resetFeedbackState();
  if (!canReadFeedback()) fs.tab = 'reports';
  await reload();
}

function stars(rating: number): string {
  return `<span title="${String(rating)} of 5">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span>`;
}

function feedbackRows(items: AppFeedback[]): string {
  if (items.length === 0) {
    return '<tr><td colspan="5" class="empty-state">No feedback matches this filter.</td></tr>';
  }
  return items
    .map(
      (item) => `<tr>
        <td>${formatDate(item.created_at)}</td>
        <td>${stars(item.rating)}</td>
        <td>${item.message ? escapeHtml(item.message) : '<span class="muted">No message</span>'}</td>
        <td><code>${escapeHtml(item.public_id)}</code><small>${escapeHtml(item.user_id)}</small>${item.email ? `<small><a href="mailto:${escapeHtml(item.email)}">${escapeHtml(item.email)}</a></small>` : ''}</td>
        <td>${escapeHtml(item.app_version ?? '—')}</td>
      </tr>`,
    )
    .join('');
}

function targetCell(report: ContentReport): string {
  if (report.target_type === 'app') return '<span class="pill">app</span>';
  const title = report.target_title ?? 'Deleted content';
  return `<span class="pill">${escapeHtml(report.target_type)}</span> ${escapeHtml(title)}${report.target_id ? `<small><code>${escapeHtml(report.target_id)}</code></small>` : ''}`;
}

function reportActions(report: ContentReport): string {
  if (!canResolveReports()) return '';
  const id = escapeHtml(report.id);
  if (report.status !== 'open') {
    return `<button type="button" class="secondary" data-report-status="open" data-report-id="${id}">Reopen</button>`;
  }
  return `<button type="button" data-report-status="resolved" data-report-id="${id}">Resolve</button>
    <button type="button" class="secondary" data-report-status="dismissed" data-report-id="${id}">Dismiss</button>`;
}

function reportRows(items: ContentReport[]): string {
  if (items.length === 0) {
    return '<tr><td colspan="6" class="empty-state">No reports match these filters.</td></tr>';
  }
  return items
    .map(
      (report) => `<tr>
        <td>${formatDate(report.created_at)}</td>
        <td>${targetCell(report)}</td>
        <td>${escapeHtml(REASON_LABELS[report.reason] ?? report.reason)}</td>
        <td>${report.message ? escapeHtml(report.message) : '<span class="muted">No message</span>'}</td>
        <td><code>${escapeHtml(report.public_id)}</code><small>${escapeHtml(report.user_id)}</small></td>
        <td><span class="pill">${escapeHtml(report.status)}</span>${report.resolved_at ? `<small>${formatDate(report.resolved_at)}</small>` : ''}<div class="row-actions">${reportActions(report)}</div></td>
      </tr>`,
    )
    .join('');
}

function pagination(nextCursor: string | null): string {
  return `<div class="monitor-pagination">
    <span>Newest first, 50 per page</span>
    <div class="row-actions">
      <button type="button" class="secondary" id="feedbackPrevious" ${fs.history.length === 0 ? 'disabled' : ''}>Previous</button>
      <button type="button" class="secondary" id="feedbackNext" ${nextCursor ? '' : 'disabled'}>Next</button>
    </div>
  </div>`;
}

function options(values: readonly string[], selected: string, blank: string): string {
  return [
    `<option value="">${escapeHtml(blank)}</option>`,
    ...values.map(
      (value) =>
        `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(value)}</option>`,
    ),
  ].join('');
}

function feedbackView(): string {
  const ratings = ['5', '4', '3', '2', '1'];
  return `
    <section class="panel table-wrap">
      <form id="feedbackFilter" class="inline-form">
        <select name="rating">${options(ratings, fs.rating, 'All ratings')}</select>
        <button type="submit">Filter</button>
      </form>
      <table>
        <thead><tr><th>Sent</th><th>Rating</th><th>Message</th><th>User</th><th>App</th></tr></thead>
        <tbody>${feedbackRows(fs.feedback?.items ?? [])}</tbody>
      </table>
      ${pagination(fs.feedback?.next_cursor ?? null)}
    </section>`;
}

function reportsView(): string {
  return `
    <section class="panel table-wrap">
      <form id="reportsFilter" class="inline-form">
        <select name="status">${options(['open', 'resolved', 'dismissed'], fs.reportStatus, 'All statuses')}</select>
        <select name="target_type">${options(['novel', 'chapter', 'app'], fs.reportTarget, 'All targets')}</select>
        <button type="submit">Filter</button>
      </form>
      <table>
        <thead><tr><th>Sent</th><th>Target</th><th>Reason</th><th>Message</th><th>Reporter</th><th>Status</th></tr></thead>
        <tbody>${reportRows(fs.reports?.items ?? [])}</tbody>
      </table>
      ${pagination(fs.reports?.next_cursor ?? null)}
    </section>`;
}

export function renderFeedbackPage(nextHost: FeedbackHost): void {
  host = nextHost;
  const tabs: Array<[FeedbackTab, string]> = canReadFeedback()
    ? [
        ['feedback', 'App feedback'],
        ['reports', 'Reports'],
      ]
    : [['reports', 'Reports']];
  nextHost.root.innerHTML = nextHost.shell(`
    <section class="page-header">
      <div>
        <p class="eyebrow">Users & growth</p>
        <h2>Feedback</h2>
      </div>
    </section>
    <div class="tab-bar">${tabs
      .map(
        ([tab, label]) =>
          `<button class="tab-button ${fs.tab === tab ? 'active' : ''}" type="button" data-feedback-tab="${tab}">${label}</button>`,
      )
      .join('')}</div>
    ${fs.tab === 'reports' ? reportsView() : feedbackView()}
  `);
  nextHost.wireShell();
  wireFeedback();
}

function restart(): void {
  fs.history = [];
  fs.cursor = undefined;
  void reload();
}

function formValue(event: SubmitEvent, name: string): string {
  return String(new FormData(event.currentTarget as HTMLFormElement).get(name) ?? '');
}

function wireFeedback(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-feedback-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      fs.tab = button.dataset['feedbackTab'] as FeedbackTab;
      restart();
    });
  });
  document
    .querySelector<HTMLFormElement>('#feedbackFilter')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      fs.rating = formValue(event, 'rating');
      restart();
    });
  document.querySelector<HTMLFormElement>('#reportsFilter')?.addEventListener('submit', (event) => {
    event.preventDefault();
    fs.reportStatus = formValue(event, 'status');
    fs.reportTarget = formValue(event, 'target_type');
    restart();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-report-status]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset['reportId'];
      const status = button.dataset['reportStatus'] as ReportStatus;
      if (!id) return;
      void run(async () => {
        await setReportStatus(id, status);
        fs.reports = await listReports();
      });
    });
  });
  document.querySelector('#feedbackNext')?.addEventListener('click', () => {
    const next = fs.tab === 'reports' ? fs.reports?.next_cursor : fs.feedback?.next_cursor;
    if (!next) return;
    fs.history.push(fs.cursor ?? '');
    fs.cursor = next;
    void reload();
  });
  document.querySelector('#feedbackPrevious')?.addEventListener('click', () => {
    if (fs.history.length === 0) return;
    const previous = fs.history.pop();
    fs.cursor = previous === '' ? undefined : previous;
    void reload();
  });
}
