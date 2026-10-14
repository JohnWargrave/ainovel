// The Feedback page of the CMS: what readers sent from the app's "Rate the app" screen. Read-only.
// Kept out of main.ts like novels.ts, which it mirrors: main.ts hands over the shell and status
// plumbing through FeedbackHost so this module never imports main.ts back.
import { api, queryString, type PagedResponse } from './api.js';
import { errorMessage, escapeHtml, formatDate } from './format.js';

export interface FeedbackHost {
  root: HTMLElement;
  shell(content: string): string;
  wireShell(): void;
  setStatus(next: { loading?: boolean; error?: string | null }): void;
}

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

interface FeedbackState {
  rating: string;
  // Cursors already visited, oldest first — the list only hands back a forward cursor.
  history: string[];
  cursor: string | undefined;
  feedback: PagedResponse<AppFeedback> | null;
}

let host: FeedbackHost | undefined;
let fs: FeedbackState = initialState();

function initialState(): FeedbackState {
  return { rating: '', history: [], cursor: undefined, feedback: null };
}

function listFeedback(): Promise<PagedResponse<AppFeedback>> {
  return api<PagedResponse<AppFeedback>>(
    `/admin/feedback${queryString({ rating: fs.rating, cursor: fs.cursor, limit: 50 })}`,
  );
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
    fs.feedback = await listFeedback();
  });
}

export function resetFeedbackState(): void {
  fs = initialState();
}

export async function loadFeedbackPage(nextHost: FeedbackHost): Promise<void> {
  host = nextHost;
  resetFeedbackState();
  await reload();
}

function stars(rating: number): string {
  return `<span class="stars" title="${String(rating)} of 5">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span>`;
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

export function renderFeedbackPage(nextHost: FeedbackHost): void {
  host = nextHost;
  const items = fs.feedback?.items ?? [];
  nextHost.root.innerHTML = nextHost.shell(`
    <section class="page-header">
      <div>
        <p class="eyebrow">Users & growth</p>
        <h2>Feedback</h2>
      </div>
      <form id="feedbackFilter" class="inline-form">
        <select name="rating">
          <option value="">All ratings</option>
          ${[5, 4, 3, 2, 1].map((rating) => `<option value="${String(rating)}" ${fs.rating === String(rating) ? 'selected' : ''}>${String(rating)} stars</option>`).join('')}
        </select>
        <button type="submit">Filter</button>
      </form>
    </section>
    <section class="panel table-wrap">
      <table>
        <thead><tr><th>Sent</th><th>Rating</th><th>Message</th><th>User</th><th>App</th></tr></thead>
        <tbody>${feedbackRows(items)}</tbody>
      </table>
      <div class="monitor-pagination">
        <span>Newest first, 50 per page</span>
        <div class="row-actions">
          <button type="button" class="secondary" id="feedbackPrevious" ${fs.history.length === 0 ? 'disabled' : ''}>Previous</button>
          <button type="button" class="secondary" id="feedbackNext" ${fs.feedback?.next_cursor ? '' : 'disabled'}>Next</button>
        </div>
      </div>
    </section>
  `);
  nextHost.wireShell();
  wireFeedback();
}

function wireFeedback(): void {
  document
    .querySelector<HTMLFormElement>('#feedbackFilter')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget as HTMLFormElement);
      fs.rating = String(form.get('rating') ?? '');
      fs.history = [];
      fs.cursor = undefined;
      void reload();
    });
  document.querySelector('#feedbackNext')?.addEventListener('click', () => {
    const next = fs.feedback?.next_cursor;
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
