import './styles.css';
import {
  ApiError,
  adjustUserCoin,
  archiveOfferwallOffer,
  approveRedemption,
  clearReferralFreeze,
  createOfferwallOffer,
  disableUserCredential,
  currentSession,
  fulfillRedemption,
  getDashboard,
  getCoinRewardSettings,
  getRedemptionSettings,
  createCatalogItem,
  getAnalyticsTimeseries,
  getDramaSettings,
  getEconomyAnalytics,
  getOfferwallAdminData,
  getReferralAdminData,
  getReferralDetail,
  getRewardMonitor,
  getRedemption,
  getRewardedAdsSettings,
  getSpinConfigs,
  getUser,
  grantUserCoin,
  listAuditLog,
  listCatalogItems,
  listRedemptions,
  listReferrals,
  listUsers,
  login,
  logout,
  pasteRedemptionCode,
  rejectRedemption,
  regenerateReferralCode,
  revokeAllUserSessions,
  revokeUserSession,
  updateOfferwallOffer,
  updateOfferwallProvider,
  updateOfferwallRegionSettings,
  updateCatalogItem,
  updateCoinRewardSettings,
  updateDramaSettings,
  updateRedemptionSettings,
  updateReferralCode,
  updateReferralSettings,
  updateRewardedAdsSettings,
  updateSpinConfig,
  type AdminUser,
  type AdminUserDetail,
  type AdminUserSummary,
  type AdminRedemptionSummary,
  type AnalyticsTimeseriesResponse,
  type AuditLogEntry,
  type CatalogItemAdmin,
  type CreateCatalogItemInput,
  type DashboardResponse,
  type EconomyAnalytics,
  type CoinRewardSettings,
  type DramaSettingsData,
  type OfferwallAdminData,
  type OfferwallOffer,
  type PagedResponse,
  type ReferralAdminData,
  type ReferralDetail,
  type RedemptionDetail,
  type RedemptionSettingsData,
  type RewardedAdsRegionSettings,
  type RewardedAdsSettingsData,
  type RewardMonitorNetwork,
  type RewardMonitorResponse,
  type SpinConfigsData,
} from './api.js';
import {
  categoryBarChart,
  compact,
  exact,
  legend,
  lineChart,
  seriesTable,
  usd,
  wireChartTooltips,
  SERIES_BURNED,
  SERIES_MINTED,
  type BarRow,
  type ChartSeries,
} from './charts.js';

type Page =
  | 'dashboard'
  | 'offers'
  | 'tapjoy-monitor'
  | 'pubscale-monitor'
  | 'users'
  | 'referrals'
  | 'redemptions'
  | 'settings'
  | 'audit';
type OfferwallTab = 'cards' | 'providers' | 'regions';
type RedemptionsTab = 'requests' | 'catalog';

interface AppState {
  session: AdminUser | null;
  page: Page;
  loading: boolean;
  error: string | null;
  dashboard: DashboardResponse | null;
  offerwall: OfferwallAdminData | null;
  offerwallTab: OfferwallTab;
  editingOfferId: string | null;
  // Range- and region-scoped copies of the dashboard's economy block. Null until the operator
  // applies a filter, at which point they override the payload's unscoped 30-day default.
  economy: EconomyAnalytics | null;
  timeseries: AnalyticsTimeseriesResponse | null;
  dashboardQuery: { days: number; region: string };
  users: PagedResponse<AdminUserSummary> | null;
  // Held in state rather than read off the form on demand: every setState re-renders the page, so
  // the inputs are rebuilt from scratch and would otherwise lose the filter on each page turn.
  userQuery: { q: string; status: string; cursor?: string };
  // The cursors already visited, oldest first. GET /admin/users is keyset-paginated and only hands
  // back a forward cursor, so stepping back means remembering where each page started. '' is the
  // unfiltered first page.
  userHistory: string[];
  referralAdmin: ReferralAdminData | null;
  redemptions: PagedResponse<AdminRedemptionSummary> | null;
  // Kept in state for the same reason as the user filter: every setState rebuilds the form.
  redemptionStatus: string;
  redemptionsTab: RedemptionsTab;
  // The reward catalog — what a user can actually exchange coin for. Only fetched for the two roles
  // the endpoint admits; a reviewer gets 403 from /admin/catalog.
  catalog: PagedResponse<CatalogItemAdmin> | null;
  catalogQuery: { is_active: string; cursor?: string };
  catalogHistory: string[];
  editingCatalogId: string | null;
  creatingCatalogItem: boolean;
  coinRewardSettings: CoinRewardSettings | null;
  redemptionSettings: RedemptionSettingsData | null;
  rewardedAdsSettings: RewardedAdsSettingsData | null;
  spinConfigs: SpinConfigsData | null;
  dramaSettings: DramaSettingsData | null;
  audit: PagedResponse<AuditLogEntry> | null;
  rewardMonitor: RewardMonitorResponse | null;
  rewardMonitorQuery: {
    window_hours: number;
    user_id: string;
    transaction_id: string;
    cursor?: string;
  };
  rewardMonitorHistory: string[];
}

const rootElement = document.querySelector<HTMLDivElement>('#app');
if (!rootElement) throw new Error('Missing #app root');
const appRoot: HTMLDivElement = rootElement;

const state: AppState = {
  session: null,
  page: 'dashboard',
  loading: true,
  error: null,
  dashboard: null,
  offerwall: null,
  offerwallTab: 'cards',
  editingOfferId: null,
  economy: null,
  timeseries: null,
  dashboardQuery: { days: 30, region: '' },
  users: null,
  userQuery: { q: '', status: '' },
  userHistory: [],
  referralAdmin: null,
  redemptions: null,
  redemptionStatus: '',
  redemptionsTab: 'requests',
  catalog: null,
  catalogQuery: { is_active: '' },
  catalogHistory: [],
  editingCatalogId: null,
  creatingCatalogItem: false,
  coinRewardSettings: null,
  redemptionSettings: null,
  rewardedAdsSettings: null,
  spinConfigs: null,
  dramaSettings: null,
  audit: null,
  rewardMonitor: null,
  rewardMonitorQuery: { window_hours: 24, user_id: '', transaction_id: '' },
  rewardMonitorHistory: [],
};

function setState(next: Partial<AppState>): void {
  Object.assign(state, next);
  render();
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected error';
}

function money(value: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
}

function integer(value: string | number): string {
  return new Intl.NumberFormat().format(Number(value));
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function localDateTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function isoDateTime(value: FormDataEntryValue | null): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return new Date(raw).toISOString();
}

function splitValues(value: FormDataEntryValue | null): string[] {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function setPage(page: Page): void {
  state.page = page;
  render();
  void loadPage(page);
}

async function runAction<T>(
  action: () => Promise<T>,
  after?: (value: T) => Partial<AppState> | void | Promise<Partial<AppState> | void>,
): Promise<void> {
  setState({ loading: true, error: null });
  try {
    const result = await action();
    const nextState = await after?.(result);
    if (nextState) {
      setState({ ...nextState, loading: false });
      return;
    }
    state.loading = false;
  } catch (error) {
    setState({ error: errorMessage(error), loading: false });
  }
}

function shell(content: string): string {
  const allTabs: Array<[Page, string]> = [
    ['dashboard', 'Dashboard'],
    ['offers', 'Offers'],
    ['tapjoy-monitor', 'Tapjoy'],
    ['pubscale-monitor', 'PubScale'],
    ['users', 'Users'],
    ['referrals', 'Referrals'],
    ['redemptions', 'Redemptions'],
    ['settings', 'Settings'],
    ['audit', 'Audit log'],
  ];
  const tabs = allTabs.filter(
    ([page]) =>
      (!['offers', 'settings'].includes(page) || state.session?.role === 'superadmin') &&
      (page !== 'referrals' || state.session?.role !== 'fulfillment'),
  );
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div>
          <p class="eyebrow">AINovel</p>
          <h1>Admin CMS</h1>
        </div>
        <nav>
          ${tabs
            .map(
              ([page, label]) =>
                `<button class="nav-button ${state.page === page ? 'active' : ''}" data-page="${page}">${label}</button>`,
            )
            .join('')}
        </nav>
        <div class="session-card">
          <strong>${state.session?.email ?? state.session?.id ?? 'Unknown admin'}</strong>
          <span>${state.session?.role ?? ''}</span>
          <button class="secondary" id="logoutButton">Log out</button>
        </div>
      </aside>
      <main class="content">
        ${state.error ? `<div class="alert">${escapeHtml(state.error)}</div>` : ''}
        ${state.loading ? '<div class="loading">Loading…</div>' : ''}
        ${content}
      </main>
    </div>
  `;
}

function renderLogin(): void {
  appRoot.innerHTML = `
    <main class="login-page">
      <section class="login-card">
        <p class="eyebrow">AINovel CMS</p>
        <h1>Admin sign in</h1>
        ${state.error ? `<div class="alert">${escapeHtml(state.error)}</div>` : ''}
        <form id="loginForm" class="form-stack">
          <label>
            Email
            <input name="email" type="email" autocomplete="username" required />
          </label>
          <label>
            Password
            <input name="password" type="password" minlength="12" maxlength="128" autocomplete="current-password" required />
          </label>
          <button type="submit">${state.loading ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </section>
    </main>
  `;
  document.querySelector<HTMLFormElement>('#loginForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    void runAction(
      async () => login(email, password),
      async (session) => {
        const dashboard = await getDashboard();
        return { session: session.admin_user, page: 'dashboard', dashboard };
      },
    );
  });
}

function wireShell(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((button) => {
    button.addEventListener('click', () => setPage(button.dataset['page'] as Page));
  });
  document.querySelector<HTMLButtonElement>('#logoutButton')?.addEventListener('click', () => {
    void runAction(
      async () => logout(),
      () => ({
        session: null,
        page: 'dashboard',
        dashboard: null,
        economy: null,
        timeseries: null,
        dashboardQuery: { days: 30, region: '' },
        offerwall: null,
        users: null,
        userQuery: { q: '', status: '' },
        userHistory: [],
        referralAdmin: null,
        redemptions: null,
        redemptionStatus: '',
        redemptionsTab: 'requests',
        catalog: null,
        catalogQuery: { is_active: '' },
        catalogHistory: [],
        editingCatalogId: null,
        creatingCatalogItem: false,
        coinRewardSettings: null,
        redemptionSettings: null,
        rewardedAdsSettings: null,
        spinConfigs: null,
        dramaSettings: null,
        audit: null,
        rewardMonitor: null,
        rewardMonitorHistory: [],
      }),
    );
  });
}

function monitorNetwork(page: Page): RewardMonitorNetwork | null {
  if (page === 'tapjoy-monitor') return 'tapjoy';
  if (page === 'pubscale-monitor') return 'pubscale';
  return null;
}

function monitorLabel(network: RewardMonitorNetwork): string {
  return network === 'tapjoy' ? 'Tapjoy' : 'PubScale';
}

function monitorVerdict(verdict: string, credited: boolean): string {
  if (credited) return 'credited';
  if (verdict === 'accepted') return 'shadow mode';
  return verdict.replaceAll('_', ' ');
}

function renderRewardMonitor(network: RewardMonitorNetwork, data?: RewardMonitorResponse): void {
  const label = monitorLabel(network);
  const summary = data?.summary;
  const query = state.rewardMonitorQuery;
  const rewards = data?.rewards ?? [];
  const callbacks = data?.recent_callbacks ?? [];
  appRoot.innerHTML = shell(`
    <section class="page-header monitor-header">
      <div>
        <p class="eyebrow">Reward operations</p>
        <h2>${label} monitor</h2>
        <p class="muted">Tracks provider callbacks and confirmed coin ledger credits.</p>
      </div>
      <button type="button" id="refreshRewardMonitor">Refresh</button>
    </section>
    <form id="rewardMonitorFilter" class="panel monitor-filter">
      <label>
        Window
        <select name="window_hours">
          ${[
            [1, '1 hour'],
            [6, '6 hours'],
            [24, '24 hours'],
            [72, '3 days'],
            [168, '7 days'],
            [720, '30 days'],
          ]
            .map(
              ([hours, text]) =>
                `<option value="${hours}" ${query.window_hours === hours ? 'selected' : ''}>${text}</option>`,
            )
            .join('')}
        </select>
      </label>
      <label>
        User ID
        <input name="user_id" value="${escapeHtml(query.user_id)}" placeholder="Exact user ID" />
      </label>
      <label>
        ${label} transaction ID
        <input name="transaction_id" value="${escapeHtml(query.transaction_id)}" placeholder="Exact provider ID" />
      </label>
      <button type="submit">Apply</button>
      <button type="button" class="secondary" id="clearRewardMonitor">Clear</button>
    </form>
    <section class="metric-grid monitor-metrics">
      <article><span>Rewards credited</span><strong>${integer(summary?.rewards_credited ?? 0)}</strong></article>
      <article><span>Coins credited</span><strong>${integer(summary?.coins_credited ?? 0)}</strong></article>
      <article><span>Unique users</span><strong>${integer(summary?.unique_users ?? 0)}</strong></article>
      <article><span>Callbacks received</span><strong>${integer(summary?.callbacks_received ?? 0)}</strong></article>
      <article class="${(summary?.callbacks_not_credited ?? 0) > 0 ? 'metric-warning' : ''}"><span>Not credited</span><strong>${integer(summary?.callbacks_not_credited ?? 0)}</strong></article>
      <article><span>Latest credit</span><strong class="metric-date">${formatDate(summary?.latest_credit_at)}</strong></article>
    </section>
    <section class="panel table-wrap monitor-section">
      <div class="section-heading">
        <div><h3>Confirmed user gains</h3><p class="muted">${rewards.length} rewards on this page. Offerwall coin remains pending until its hold expires.</p></div>
        ${data ? `<small>${formatDate(data.from)} to ${formatDate(data.to)}</small>` : ''}
      </div>
      <table>
        <thead><tr><th>Created</th><th>User</th><th>Coin</th><th>${label} ID</th><th>Value / share</th><th>Wallet</th></tr></thead>
        <tbody>
          ${
            rewards.length > 0
              ? rewards
                  .map(
                    (reward) => `<tr>
                      <td>${formatDate(reward.created_at)}</td>
                      <td><code>${escapeHtml(reward.user_id)}</code></td>
                      <td><strong class="positive">+${integer(reward.coins_awarded)}</strong></td>
                      <td><code>${escapeHtml(reward.transaction_id ?? '—')}</code></td>
                      <td><strong>${reward.payout_usd === null ? '—' : money(Number(reward.payout_usd))}</strong><small>${reward.share_applied === null ? '—' : `${Math.round(Number(reward.share_applied) * 100)}% share`}</small></td>
                      <td><span class="pill status-${escapeHtml(reward.bucket)}">${escapeHtml(reward.bucket)}</span><small>Available: ${integer(reward.available_balance_after)}</small><small>${reward.hold_until ? `Hold to ${formatDate(reward.hold_until)}` : ''}</small></td>
                    </tr>`,
                  )
                  .join('')
              : '<tr><td colspan="6" class="empty-state">No confirmed credits match these filters.</td></tr>'
          }
        </tbody>
      </table>
      <div class="monitor-pagination">
        <span>Up to 50 rewards per page</span>
        <div class="row-actions">
          <button type="button" class="secondary" id="previousRewardPage" ${state.rewardMonitorHistory.length === 0 ? 'disabled' : ''}>Previous</button>
          <button type="button" class="secondary" id="nextRewardPage" ${data?.next_cursor ? '' : 'disabled'}>Next</button>
        </div>
      </div>
    </section>
    <section class="panel table-wrap monitor-section">
      <div class="section-heading"><div><h3>Recent callbacks</h3><p class="muted">Use this list to diagnose completed offers that did not produce a ledger credit.</p></div></div>
      <table>
        <thead><tr><th>Received</th><th>Outcome</th><th>User</th><th>${label} ID</th></tr></thead>
        <tbody>
          ${
            callbacks.length > 0
              ? callbacks
                  .map((callback) => {
                    const credited = callback.earning_event_id !== null;
                    const outcome = monitorVerdict(callback.verdict, credited);
                    return `<tr>
                      <td>${formatDate(callback.created_at)}</td>
                      <td><span class="pill verdict-${escapeHtml(credited ? 'credited' : callback.verdict)}">${escapeHtml(outcome)}</span></td>
                      <td><code>${escapeHtml(callback.user_id ?? '—')}</code></td>
                      <td><code>${escapeHtml(callback.transaction_id ?? '—')}</code></td>
                    </tr>`;
                  })
                  .join('')
              : '<tr><td colspan="4" class="empty-state">No callbacks match these filters.</td></tr>'
          }
        </tbody>
      </table>
    </section>
  `);
  wireShell();
  wireRewardMonitor(network, data);
}

function rewardMonitorRequest(
  network: RewardMonitorNetwork,
  query = state.rewardMonitorQuery,
): Promise<RewardMonitorResponse> {
  return getRewardMonitor(network, {
    window_hours: query.window_hours,
    ...(query.user_id ? { user_id: query.user_id } : {}),
    ...(query.transaction_id ? { transaction_id: query.transaction_id } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
}

function rewardMonitorQueryWithoutCursor(): AppState['rewardMonitorQuery'] {
  return {
    window_hours: state.rewardMonitorQuery.window_hours,
    user_id: state.rewardMonitorQuery.user_id,
    transaction_id: state.rewardMonitorQuery.transaction_id,
  };
}

function wireRewardMonitor(network: RewardMonitorNetwork, data?: RewardMonitorResponse): void {
  document
    .querySelector<HTMLButtonElement>('#refreshRewardMonitor')
    ?.addEventListener('click', () => {
      void runAction(
        () => rewardMonitorRequest(network),
        (rewardMonitor) => ({ rewardMonitor }),
      );
    });
  document
    .querySelector<HTMLFormElement>('#rewardMonitorFilter')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget as HTMLFormElement);
      const rewardMonitorQuery = {
        window_hours: Number(form.get('window_hours')),
        user_id: String(form.get('user_id') ?? '').trim(),
        transaction_id: String(form.get('transaction_id') ?? '').trim(),
      };
      state.rewardMonitorQuery = rewardMonitorQuery;
      state.rewardMonitorHistory = [];
      void runAction(
        () => rewardMonitorRequest(network, rewardMonitorQuery),
        (rewardMonitor) => ({ rewardMonitor }),
      );
    });
  document
    .querySelector<HTMLButtonElement>('#clearRewardMonitor')
    ?.addEventListener('click', () => {
      const rewardMonitorQuery = { window_hours: 24, user_id: '', transaction_id: '' };
      state.rewardMonitorQuery = rewardMonitorQuery;
      state.rewardMonitorHistory = [];
      void runAction(
        () => rewardMonitorRequest(network, rewardMonitorQuery),
        (rewardMonitor) => ({ rewardMonitor }),
      );
    });
  document.querySelector<HTMLButtonElement>('#nextRewardPage')?.addEventListener('click', () => {
    if (!data?.next_cursor) return;
    state.rewardMonitorHistory.push(state.rewardMonitorQuery.cursor ?? '');
    state.rewardMonitorQuery = { ...state.rewardMonitorQuery, cursor: data.next_cursor };
    void runAction(
      () => rewardMonitorRequest(network),
      (rewardMonitor) => ({ rewardMonitor }),
    );
  });
  document
    .querySelector<HTMLButtonElement>('#previousRewardPage')
    ?.addEventListener('click', () => {
      const cursor = state.rewardMonitorHistory.pop();
      if (cursor === undefined) return;
      const baseQuery = rewardMonitorQueryWithoutCursor();
      state.rewardMonitorQuery = cursor ? { ...baseQuery, cursor } : baseQuery;
      void runAction(
        () => rewardMonitorRequest(network),
        (rewardMonitor) => ({ rewardMonitor }),
      );
    });
}

// I2 (01-COIN-ECONOMY.md): unbacked coin is meant to stay under 35% of lifetime mint, and the
// backing-ratio alert job fires below 1.2. Both are already enforced elsewhere in the backend; the
// dashboard's job is to make them visible before someone reads about it in the audit log.
const UNBACKED_PCT_CEILING = 0.35;
const BACKING_RATIO_FLOOR = 1.2;

interface EconomyAlert {
  level: 'critical' | 'warning';
  title: string;
  detail: string;
}

function economyAlerts(economy: EconomyAnalytics): EconomyAlert[] {
  const alerts: EconomyAlert[] = [];
  if (economy.mint_paused) {
    alerts.push({
      level: 'critical',
      title: 'Minting is paused',
      detail: 'Free-coin earning is rejected in this region until the kill-switch is cleared.',
    });
  }
  if (economy.unbacked_pct > UNBACKED_PCT_CEILING) {
    alerts.push({
      level: 'critical',
      title: `Unbacked coin at ${(economy.unbacked_pct * 100).toFixed(1)}%`,
      detail: `Target is under ${String(UNBACKED_PCT_CEILING * 100)}%. Coin is being minted faster than revenue backs it.`,
    });
  }
  if (economy.backing_ratio_today !== null && economy.backing_ratio_today < BACKING_RATIO_FLOOR) {
    alerts.push({
      level: 'warning',
      title: `Backing ratio ${economy.backing_ratio_today.toFixed(3)} today`,
      detail: `Alert threshold is ${String(BACKING_RATIO_FLOOR)}.`,
    });
  }
  return alerts;
}

// Status colour never carries the meaning alone — each row ships an icon and a written label.
function alertBanner(alerts: EconomyAlert[]): string {
  if (alerts.length === 0) return '';
  return `<section class="alert-stack">${alerts
    .map(
      (alert) => `<div class="alert alert-${alert.level}">
        <span class="alert-icon" aria-hidden="true">${alert.level === 'critical' ? '!' : '▲'}</span>
        <div>
          <strong>${escapeHtml(alert.level === 'critical' ? 'Critical' : 'Warning')} — ${escapeHtml(alert.title)}</strong>
          <small>${escapeHtml(alert.detail)}</small>
        </div>
      </div>`,
    )
    .join('')}</section>`;
}

const RANGE_OPTIONS: Array<[number, string]> = [
  [7, 'Last 7 days'],
  [30, 'Last 30 days'],
  [90, 'Last 90 days'],
];

function byValueDesc(record: Record<string, string>): BarRow[] {
  return Object.entries(record)
    .map(([label, value]) => ({ label, value: Number(value) }))
    .sort((a, b) => b.value - a.value);
}

function renderDashboard(data?: DashboardResponse): void {
  if (!data) {
    appRoot.innerHTML = shell('<section class="panel"><h2>Dashboard</h2></section>');
    wireShell();
    return;
  }
  // Range- and region-scoped when a filter is applied; otherwise the payload's own 30-day default.
  const economy = state.economy ?? data.economy;
  const points = state.timeseries?.points ?? [];
  const dates = points.map((point) => point.date);
  const rangeLabel =
    RANGE_OPTIONS.find(([days]) => days === state.dashboardQuery.days)?.[1] ?? 'Last 30 days';
  const scope = state.dashboardQuery.region || 'All regions';

  const coinSeries: ChartSeries[] = [
    { label: 'Minted', color: SERIES_MINTED, values: points.map((p) => Number(p.coin_minted)) },
    { label: 'Burned', color: SERIES_BURNED, values: points.map((p) => Number(p.coin_burned)) },
  ];
  const userSeries: ChartSeries[] = [
    { label: 'New users', color: SERIES_MINTED, values: points.map((p) => p.new_users) },
  ];
  const revenueSeries: ChartSeries[] = [
    { label: 'Revenue', color: SERIES_MINTED, values: points.map((p) => p.revenue_usd) },
  ];
  const clawbacks = Object.entries(economy.clawback_rate_by_network);

  appRoot.innerHTML = shell(`
    <section class="page-header">
      <div>
        <p class="eyebrow">Operations</p>
        <h2>Dashboard</h2>
      </div>
      <form id="dashboardFilter" class="inline-form">
        <select name="region">
          <option value="">All regions</option>
          ${data.regions
            .map(
              (region) =>
                `<option value="${escapeHtml(region)}" ${state.dashboardQuery.region === region ? 'selected' : ''}>${escapeHtml(region)}</option>`,
            )
            .join('')}
        </select>
        <select name="days">
          ${RANGE_OPTIONS.map(
            ([days, label]) =>
              `<option value="${String(days)}" ${state.dashboardQuery.days === days ? 'selected' : ''}>${label}</option>`,
          ).join('')}
        </select>
        <button type="submit">Apply</button>
      </form>
    </section>
    ${alertBanner(economyAlerts(economy))}
    <section class="metric-grid">
      <article><span>Users<small class="scope-note">all regions · lifetime</small></span><strong>${integer(data.counts.users_total)}</strong></article>
      <article><span>Pending redemptions<small class="scope-note">all regions · now</small></span><strong>${integer(data.counts.redemptions_pending)}</strong></article>
      <article><span>Open fraud flags<small class="scope-note">all regions · now</small></span><strong>${integer(data.counts.fraud_flags_open)}</strong></article>
      <article><span>Active catalog items<small class="scope-note">all regions · now</small></span><strong>${integer(data.counts.catalog_items_active)}</strong></article>
    </section>
    <article class="panel viz-card">
      <div class="section-heading">
        <div><p class="eyebrow">${escapeHtml(scope)} · ${escapeHtml(rangeLabel)}</p><h3>Coin minted and burned per day</h3></div>
        ${legend(coinSeries)}
      </div>
      ${lineChart({ labels: dates, series: coinSeries, format: exact })}
      ${seriesTable(dates, coinSeries, exact)}
    </article>
    <section class="two-column">
      <article class="panel viz-card">
        <div class="section-heading"><div><p class="eyebrow">${escapeHtml(rangeLabel)}</p><h3>New users per day</h3></div></div>
        ${lineChart({ labels: dates, series: userSeries, format: exact, height: 200 })}
      </article>
      <article class="panel viz-card">
        <div class="section-heading"><div><p class="eyebrow">${escapeHtml(rangeLabel)}</p><h3>Revenue per day</h3></div></div>
        ${lineChart({ labels: dates, series: revenueSeries, format: usd, height: 200 })}
      </article>
    </section>
    <section class="two-column">
      <article class="panel viz-card">
        <div class="section-heading"><div><p class="eyebrow">${escapeHtml(rangeLabel)}</p><h3>Coin minted by source</h3></div></div>
        ${categoryBarChart({ rows: byValueDesc(economy.coin_minted_by_source), color: SERIES_MINTED, format: compact })}
      </article>
      <article class="panel viz-card">
        <div class="section-heading"><div><p class="eyebrow">${escapeHtml(rangeLabel)}</p><h3>Coin burned by sink</h3></div></div>
        ${categoryBarChart({ rows: byValueDesc(economy.coin_burned_by_sink), color: SERIES_BURNED, format: compact })}
      </article>
    </section>
    <section class="two-column">
      <article class="panel">
        <h3>Economy totals</h3>
        <dl class="details-grid">
          <dt>Minted</dt><dd>${integer(economy.coin_minted_total)}</dd>
          <dt>Burned</dt><dd>${integer(economy.coin_burned_total)}</dd>
          <dt>Unbacked</dt><dd>${integer(economy.unbacked_coin)} (${(economy.unbacked_pct * 100).toFixed(2)}%)</dd>
          <dt>Redeemed cost</dt><dd>${money(economy.coin_redeemed_usd_cost)}</dd>
          <dt>Revenue</dt><dd>${money(economy.revenue_usd)}</dd>
        </dl>
        <h3>Clawback rate by network</h3>
        ${
          clawbacks.length > 0
            ? `<table class="compact-table"><tbody>${clawbacks
                .map(
                  ([network, rate]) =>
                    `<tr><td>${escapeHtml(network)}</td><td class="numeric">${(rate * 100).toFixed(2)}%</td></tr>`,
                )
                .join('')}</tbody></table>`
            : '<p class="muted">No terminal earning events in this range yet.</p>'
        }
      </article>
      <article class="panel">
        <h3>Recent audit entries</h3>
        ${auditList(data.recent_audit_log)}
      </article>
    </section>
  `);
  wireShell();
  wireChartTooltips();
  document
    .querySelector<HTMLFormElement>('#dashboardFilter')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget as HTMLFormElement);
      state.dashboardQuery = {
        region: String(form.get('region') ?? ''),
        days: Number(form.get('days')),
      };
      void runAction(loadDashboardSlice, (slice) => slice);
    });
}

/**
 * The counts and the audit log are global and do not move with the filter, so only the two
 * range-scoped payloads are refetched. `from` is derived here rather than sent as a day count
 * because /admin/analytics/economy takes absolute bounds.
 */
async function loadDashboardSlice(): Promise<Partial<AppState>> {
  const { days, region } = state.dashboardQuery;
  const from = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString();
  const [economy, timeseries] = await Promise.all([
    getEconomyAnalytics({ from, ...(region ? { region } : {}) }),
    getAnalyticsTimeseries({ days, ...(region ? { region } : {}) }),
  ]);
  return { economy, timeseries };
}

function offerEditor(data: OfferwallAdminData, offer?: OfferwallOffer): string {
  const isEditing = Boolean(offer);
  const regionIds = new Set(offer?.region_ids ?? data.settings.map((region) => region.region_id));
  return `
    <section class="panel offer-editor">
      <div class="section-heading">
        <div>
          <p class="eyebrow">${isEditing ? 'Edit card' : 'New card'}</p>
          <h3>${escapeHtml(offer?.name ?? 'Create offer')}</h3>
        </div>
        <button class="secondary icon-button" type="button" id="closeOfferEditor" aria-label="Close editor" title="Close editor">×</button>
      </div>
      <div class="editor-layout">
        <form id="offerForm" class="form-grid">
          <label>Code<input name="code" value="${escapeHtml(offer?.code ?? '')}" placeholder="offer3" required pattern="[a-z0-9][a-z0-9_-]+" /></label>
          <label>Provider<select name="provider" required>${data.providers
            .map(
              (provider) =>
                `<option value="${escapeHtml(provider.provider)}" ${offer?.provider === provider.provider ? 'selected' : ''}>${escapeHtml(provider.display_name ?? provider.provider)}</option>`,
            )
            .join('')}</select></label>
          <label>Name<input name="name" value="${escapeHtml(offer?.name ?? '')}" placeholder="Featured offers" required /></label>
          <label>Status<select name="status">${['draft', 'active', 'paused', 'archived']
            .map(
              (status) =>
                `<option value="${status}" ${(offer?.status ?? 'draft') === status ? 'selected' : ''}>${status}</option>`,
            )
            .join('')}</select></label>
          <label class="field-wide">Description<textarea name="description" rows="3" placeholder="Complete offers and earn coins">${escapeHtml(offer?.description ?? '')}</textarea></label>
          <label>Icon URL<input name="icon_url" type="url" value="${escapeHtml(offer?.icon_url ?? '')}" placeholder="https://…" /></label>
          <label>Badge<input name="badge_text" value="${escapeHtml(offer?.badge_text ?? '')}" placeholder="Featured" /></label>
          <label>Placement override<input name="placement" value="${escapeHtml(offer?.placement ?? '')}" placeholder="Use provider default" /></label>
          <label>Display order<input name="sort_order" type="number" min="0" max="100000" value="${String(offer?.sort_order ?? 0)}" required /></label>
          <label>Starts at<input name="starts_at" type="datetime-local" value="${localDateTime(offer?.starts_at ?? null)}" /></label>
          <label>Ends at<input name="ends_at" type="datetime-local" value="${localDateTime(offer?.ends_at ?? null)}" /></label>
          <fieldset class="field-wide check-group">
            <legend>Regions</legend>
            ${data.settings
              .map(
                (region) =>
                  `<label class="check-label"><input type="checkbox" name="region_ids" value="${escapeHtml(region.region_id)}" ${regionIds.has(region.region_id) ? 'checked' : ''} /> ${escapeHtml(region.region_id)}</label>`,
              )
              .join('')}
          </fieldset>
          <div class="field-wide form-actions">
            <button type="submit">${isEditing ? 'Save changes' : 'Create offer'}</button>
            <button class="secondary" type="button" id="cancelOfferEditor">Cancel</button>
          </div>
        </form>
        <aside class="offer-preview" aria-label="Mobile card preview">
          <p class="eyebrow">Preview</p>
          <div class="mobile-offer-card">
            <div class="offer-logo" data-preview-logo>${offer?.icon_url ? `<img src="${escapeHtml(offer.icon_url)}" alt="" />` : escapeHtml((offer?.provider ?? 'O').slice(0, 1).toUpperCase())}</div>
            <div>
              <strong data-preview-name>${escapeHtml(offer?.name ?? 'Offer name')}</strong>
              <span data-preview-description>${escapeHtml(offer?.description ?? 'Complete offers and earn coins')}</span>
            </div>
            <span class="offer-chevron">›</span>
          </div>
          <p class="muted preview-meta"><span data-preview-provider>${escapeHtml(offer?.provider ?? data.providers[0]?.provider ?? '')}</span> · SDK placement</p>
        </aside>
      </div>
    </section>
  `;
}

function renderOfferCards(data: OfferwallAdminData): string {
  const editing =
    state.editingOfferId === 'new'
      ? offerEditor(data)
      : state.editingOfferId
        ? offerEditor(
            data,
            data.offers.find((offer) => offer.id === state.editingOfferId),
          )
        : '';
  return `
    <div class="toolbar-row">
      <div class="status-summary">
        <strong>${data.offers.filter((offer) => offer.status === 'active').length}</strong>
        <span>active of ${data.offers.length} cards</span>
      </div>
      <button type="button" id="newOfferButton">Create offer</button>
    </div>
    <section class="panel table-wrap">
      <table>
        <thead><tr><th>Offer</th><th>Provider</th><th>Regions</th><th>Placement</th><th>Order</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${data.offers
            .map(
              (offer) => `<tr>
                <td><div class="table-offer"><span class="table-logo">${offer.icon_url ? `<img src="${escapeHtml(offer.icon_url)}" alt="" />` : escapeHtml(offer.provider.slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(offer.name)}</strong><small>${escapeHtml(offer.code)} · ${escapeHtml(offer.description)}</small></span></div></td>
                <td>${escapeHtml(offer.provider)}</td>
                <td>${offer.region_ids.map(escapeHtml).join(', ')}</td>
                <td>${escapeHtml(offer.placement ?? 'Provider default')}</td>
                <td>${offer.sort_order}</td>
                <td><span class="pill status-${offer.status}">${escapeHtml(offer.status)}</span></td>
                <td><div class="row-actions"><button class="secondary" type="button" data-edit-offer="${offer.id}">Edit</button>${offer.status !== 'archived' ? `<button class="secondary" type="button" data-toggle-offer="${offer.id}" data-next-status="${offer.status === 'active' ? 'paused' : 'active'}">${offer.status === 'active' ? 'Pause' : 'Activate'}</button><button class="danger subtle" type="button" data-archive-offer="${offer.id}">Archive</button>` : ''}</div></td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </section>
    ${editing}
  `;
}

function renderProviderSettings(data: OfferwallAdminData): string {
  return `<section class="settings-list">
    ${data.providers
      .map(
        (
          provider,
        ) => `<form class="panel provider-form" data-provider-form="${escapeHtml(provider.provider)}">
          <div class="section-heading">
            <div><p class="eyebrow">Provider</p><h3>${escapeHtml(provider.display_name ?? provider.provider)}</h3></div>
            <div class="provider-health"><span class="health-dot ${provider.secret_configured ? 'healthy' : 'warning'}"></span>${provider.secret_configured ? 'Secret configured' : 'Secret missing'}</div>
          </div>
          <div class="form-grid three-column">
            <label>Display name<input name="display_name" value="${escapeHtml(provider.display_name ?? '')}" /></label>
            <label>Icon URL<input name="icon_url" type="url" value="${escapeHtml(provider.icon_url ?? '')}" /></label>
            <label>Placement<input name="placement" value="${escapeHtml(provider.placement ?? '')}" ${provider.placement_source === 'environment' ? 'disabled' : ''} /><small>${provider.placement_source === 'environment' ? 'Controlled by environment' : 'Database value'}</small></label>
            <label>Currency per USD<input name="currency_per_usd" type="number" min="0.0001" step="0.0001" value="${escapeHtml(provider.currency_per_usd ?? '')}" /></label>
            <label>Standard hold hours<input name="hold_hours" type="number" min="0" max="720" value="${provider.hold_hours}" required /></label>
            <label>High-value above (USD)<input name="high_value_threshold_usd" type="number" min="0.0001" max="1000000" step="0.0001" value="${escapeHtml(provider.high_value_threshold_usd)}" required /></label>
            <label>High-value hold hours<input name="high_value_hold_hours" type="number" min="0" max="720" value="${provider.high_value_hold_hours}" required /></label>
            <label class="field-wide">Callback IPs<textarea name="allowed_ips" rows="3">${escapeHtml(provider.allowed_ips.join('\n'))}</textarea></label>
            <label class="switch-label immediate-credit-toggle"><input name="credit_immediately" type="checkbox" ${provider.credit_immediately ? 'checked' : ''} /><span><strong>Credit rewards immediately</strong><small>Add new rewards directly to the available wallet balance.</small></span></label>
            <label class="check-label"><input name="is_active" type="checkbox" ${provider.is_active ? 'checked' : ''} /> Provider active</label>
            <label class="check-label"><input name="shadow_mode" type="checkbox" ${provider.shadow_mode ? 'checked' : ''} /> Shadow mode</label>
          </div>
          <div class="callback-row"><span>Callback</span><code>${escapeHtml(provider.callback_url)}</code></div>
          <div class="form-actions"><button type="submit">Save provider</button></div>
        </form>`,
      )
      .join('')}
  </section>`;
}

function renderRegionSettings(data: OfferwallAdminData): string {
  return `<section class="settings-list">
    ${data.settings
      .map(
        (
          region,
        ) => `<form class="panel region-form" data-region-form="${escapeHtml(region.region_id)}">
          <div class="section-heading"><div><p class="eyebrow">Region</p><h3>${escapeHtml(region.region_id)}</h3></div><label class="switch-label"><input name="enabled" type="checkbox" ${region.enabled ? 'checked' : ''} /> Offerwall enabled</label></div>
          <fieldset class="check-group"><legend>Providers</legend>${data.providers
            .map(
              (provider) =>
                `<label class="check-label"><input name="networks" type="checkbox" value="${escapeHtml(provider.provider)}" ${region.networks.includes(provider.provider) ? 'checked' : ''} /> ${escapeHtml(provider.display_name ?? provider.provider)}</label>`,
            )
            .join('')}</fieldset>
          <div class="share-grid">
            ${(['0', '1', '2', '3'] as const)
              .map(
                (level) =>
                  `<label>Trust L${level}<span class="input-suffix"><input name="share_${level}" type="number" min="0" max="60" step="0.1" value="${(region.shares[level] * 100).toFixed(1)}" required /><b>%</b></span></label>`,
              )
              .join('')}
          </div>
          <div class="form-actions"><button type="submit">Save region</button><span class="muted">Updated ${formatDate(region.updated_at)}</span></div>
        </form>`,
      )
      .join('')}
  </section>`;
}

function renderOffers(data?: OfferwallAdminData): void {
  const tabLabels: Array<[OfferwallTab, string]> = [
    ['cards', 'Offer cards'],
    ['providers', 'Providers'],
    ['regions', 'Regions'],
  ];
  appRoot.innerHTML = shell(`
    <section class="page-header">
      <div><p class="eyebrow">Earning inventory</p><h2>Offers</h2></div>
    </section>
    <div class="tab-bar">${tabLabels.map(([tab, label]) => `<button class="tab-button ${state.offerwallTab === tab ? 'active' : ''}" type="button" data-offerwall-tab="${tab}">${label}</button>`).join('')}</div>
    ${data ? (state.offerwallTab === 'cards' ? renderOfferCards(data) : state.offerwallTab === 'providers' ? renderProviderSettings(data) : renderRegionSettings(data)) : '<section class="panel"><p class="muted">Loading offerwall configuration.</p></section>'}
  `);
  wireShell();
  wireOfferwall(data);
}

function refreshedOfferwall(): Promise<Partial<AppState>> {
  return getOfferwallAdminData().then((offerwall) => ({ offerwall, editingOfferId: null }));
}

function wireOfferPreview(form: HTMLFormElement): void {
  const update = (): void => {
    const values = new FormData(form);
    const name = String(values.get('name') ?? '').trim() || 'Offer name';
    const description =
      String(values.get('description') ?? '').trim() || 'Complete offers and earn coins';
    const provider = String(values.get('provider') ?? '');
    const iconUrl = String(values.get('icon_url') ?? '').trim();
    const nameNode = document.querySelector<HTMLElement>('[data-preview-name]');
    const descriptionNode = document.querySelector<HTMLElement>('[data-preview-description]');
    const providerNode = document.querySelector<HTMLElement>('[data-preview-provider]');
    const logoNode = document.querySelector<HTMLElement>('[data-preview-logo]');
    if (nameNode) nameNode.textContent = name;
    if (descriptionNode) descriptionNode.textContent = description;
    if (providerNode) providerNode.textContent = provider;
    if (logoNode) {
      logoNode.textContent = '';
      if (iconUrl) {
        const image = document.createElement('img');
        image.src = iconUrl;
        image.alt = '';
        logoNode.append(image);
      } else {
        logoNode.textContent = provider.slice(0, 1).toUpperCase() || 'O';
      }
    }
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
}

function wireOfferwall(data?: OfferwallAdminData): void {
  document.querySelectorAll<HTMLButtonElement>('[data-offerwall-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.offerwallTab = button.dataset['offerwallTab'] as OfferwallTab;
      state.editingOfferId = null;
      render();
    });
  });
  if (!data) return;

  document.querySelector<HTMLButtonElement>('#newOfferButton')?.addEventListener('click', () => {
    state.editingOfferId = 'new';
    render();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-edit-offer]').forEach((button) => {
    button.addEventListener('click', () => {
      state.editingOfferId = button.dataset['editOffer'] ?? null;
      render();
    });
  });
  const closeEditor = (): void => {
    state.editingOfferId = null;
    render();
  };
  document
    .querySelector<HTMLButtonElement>('#closeOfferEditor')
    ?.addEventListener('click', closeEditor);
  document
    .querySelector<HTMLButtonElement>('#cancelOfferEditor')
    ?.addEventListener('click', closeEditor);

  document.querySelectorAll<HTMLButtonElement>('[data-toggle-offer]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset['toggleOffer'];
      const status = button.dataset['nextStatus'] as 'active' | 'paused' | undefined;
      if (id && status)
        void runAction(() => updateOfferwallOffer(id, { status }), refreshedOfferwall);
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-archive-offer]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset['archiveOffer'];
      if (id && window.confirm('Archive this offer? It will disappear from the app.')) {
        void runAction(() => archiveOfferwallOffer(id), refreshedOfferwall);
      }
    });
  });

  const offerForm = document.querySelector<HTMLFormElement>('#offerForm');
  if (offerForm) {
    wireOfferPreview(offerForm);
    offerForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(offerForm);
      const input = {
        code: String(values.get('code') ?? '').trim(),
        provider: String(values.get('provider') ?? ''),
        name: String(values.get('name') ?? '').trim(),
        description: String(values.get('description') ?? '').trim(),
        icon_url: String(values.get('icon_url') ?? '').trim() || null,
        badge_text: String(values.get('badge_text') ?? '').trim() || null,
        placement: String(values.get('placement') ?? '').trim() || null,
        region_ids: values.getAll('region_ids').map(String),
        sort_order: Number(values.get('sort_order')),
        status: String(values.get('status')) as OfferwallOffer['status'],
        starts_at: isoDateTime(values.get('starts_at')),
        ends_at: isoDateTime(values.get('ends_at')),
      };
      const id = state.editingOfferId;
      void runAction(
        () => (id && id !== 'new' ? updateOfferwallOffer(id, input) : createOfferwallOffer(input)),
        refreshedOfferwall,
      );
    });
  }

  document.querySelectorAll<HTMLFormElement>('[data-provider-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const provider = form.dataset['providerForm'];
      if (!provider) return;
      const values = new FormData(form);
      const placementInput = form.elements.namedItem('placement') as HTMLInputElement | null;
      const currencyRaw = String(values.get('currency_per_usd') ?? '').trim();
      const input = {
        display_name: String(values.get('display_name') ?? '').trim() || null,
        icon_url: String(values.get('icon_url') ?? '').trim() || null,
        ...(placementInput?.disabled
          ? {}
          : { placement: String(values.get('placement') ?? '').trim() || null }),
        allowed_ips: splitValues(values.get('allowed_ips')),
        currency_per_usd: currencyRaw ? Number(currencyRaw) : null,
        hold_hours: Number(values.get('hold_hours')),
        high_value_threshold_usd: Number(values.get('high_value_threshold_usd')),
        high_value_hold_hours: Number(values.get('high_value_hold_hours')),
        credit_immediately: values.get('credit_immediately') === 'on',
        is_active: values.get('is_active') === 'on',
        shadow_mode: values.get('shadow_mode') === 'on',
      };
      void runAction(() => updateOfferwallProvider(provider, input), refreshedOfferwall);
    });
  });

  document.querySelectorAll<HTMLFormElement>('[data-region-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const regionId = form.dataset['regionForm'];
      if (!regionId) return;
      const values = new FormData(form);
      void runAction(
        () =>
          updateOfferwallRegionSettings(regionId, {
            enabled: values.get('enabled') === 'on',
            networks: values.getAll('networks').map(String),
            shares: {
              '0': Number(values.get('share_0')) / 100,
              '1': Number(values.get('share_1')) / 100,
              '2': Number(values.get('share_2')) / 100,
              '3': Number(values.get('share_3')) / 100,
            },
          }),
        refreshedOfferwall,
      );
    });
  });
}

function renderReferrals(data?: ReferralAdminData): void {
  const referrals = data?.referrals.items ?? [];
  const totalInvites = referrals.reduce((total, row) => total + row.total_referrals, 0);
  const totalQualified = referrals.reduce((total, row) => total + row.qualified_referrals, 0);
  const totalEarned = referrals.reduce((total, row) => total + BigInt(row.total_earned_coin), 0n);
  const totalPending = referrals.reduce(
    (total, row) => total + BigInt(row.pending_earned_coin),
    0n,
  );
  const canConfigure = state.session?.role === 'superadmin';

  appRoot.innerHTML = shell(`
    <section class="page-header">
      <div><p class="eyebrow">Growth operations</p><h2>Referrals</h2></div>
      <form id="referralSearch" class="inline-form">
        <input name="q" placeholder="User ID, username, email, code" />
        <select name="region_id">
          <option value="">All regions</option>
          ${(data?.settings ?? []).map((setting) => `<option value="${escapeHtml(setting.region_id)}">${escapeHtml(setting.region_id)}</option>`).join('')}
        </select>
        <button type="submit">Search</button>
      </form>
    </section>
    <section class="metric-grid compact-metrics">
      <article><span>Page invites</span><strong>${integer(totalInvites)}</strong></article>
      <article><span>Page qualified</span><strong>${integer(totalQualified)}</strong></article>
      <article><span>Page net coin</span><strong>${integer(totalEarned.toString())}</strong></article>
      <article><span>Page pending coin</span><strong>${integer(totalPending.toString())}</strong></article>
    </section>
    <section class="referral-settings-grid">
      ${(data?.settings ?? [])
        .map(
          (
            setting,
          ) => `<form class="panel referral-settings-form" data-referral-region="${escapeHtml(setting.region_id)}">
            <div class="section-heading">
              <div><p class="eyebrow">Region</p><h3>${escapeHtml(setting.region_id)}</h3></div>
              <label class="switch-label"><input name="enabled" type="checkbox" ${setting.enabled ? 'checked' : ''} ${canConfigure ? '' : 'disabled'} /> Enabled</label>
            </div>
            <div class="form-grid three-column">
              <label>Reward rate<span class="input-suffix"><input name="reward_pct" type="number" min="0" max="50" step="0.1" value="${setting.reward_pct * 100}" ${canConfigure ? '' : 'disabled'} required /><b>%</b></span></label>
              <label>Wait time<span class="input-suffix"><input name="hold_hours" type="number" min="0" max="720" step="1" value="${setting.hold_hours}" ${canConfigure ? '' : 'disabled'} required /><b>h</b></span></label>
              <label>Earning duration<span class="input-suffix"><input name="duration_months" type="number" min="1" max="120" step="1" value="${setting.duration_months ?? ''}" placeholder="Lifetime" ${canConfigure ? '' : 'disabled'} /><b>mo</b></span></label>
              <label>Milestone coin<input name="milestone_bonus_coin" type="number" min="0" max="10000000" step="1" value="${setting.milestone_bonus_coin}" ${canConfigure ? '' : 'disabled'} required /></label>
              <label>Milestone threshold<input name="milestone_bonus_threshold" type="number" min="1" max="1000000000" step="1" value="${setting.milestone_bonus_threshold}" ${canConfigure ? '' : 'disabled'} required /></label>
              <label class="switch-label immediate-credit-toggle"><input name="credit_immediately" type="checkbox" ${setting.credit_immediately ? 'checked' : ''} ${canConfigure ? '' : 'disabled'} /><span><strong>Credit rewards immediately</strong><small>Add new referral rewards directly to the available wallet balance.</small></span></label>
            </div>
            <div class="form-actions">
              ${canConfigure ? '<button type="submit">Save region</button>' : ''}
              <span class="muted">Updated ${formatDate(setting.updated_at)}</span>
            </div>
          </form>`,
        )
        .join('')}
    </section>
    <section class="panel table-wrap referral-table">
      <div class="section-heading"><h3>Referral accounts</h3><span class="muted">${referrals.length} results</span></div>
      <table>
        <thead><tr><th>User / code</th><th>Region</th><th>Invites</th><th>Referral coin</th><th>Risk</th><th></th></tr></thead>
        <tbody>
          ${
            referrals.length === 0
              ? '<tr><td colspan="6" class="empty-state">No referral accounts found.</td></tr>'
              : referrals
                  .map(
                    (row) => `<tr>
                <td><strong>${escapeHtml(row.email ?? row.user_id)}</strong><small>${escapeHtml(row.referral_code ?? 'No code')} · ${escapeHtml(row.user_id)}</small></td>
                <td>${escapeHtml(row.region_id)}</td>
                <td><strong>${row.qualified_referrals} qualified</strong><small>${row.pending_referrals} pending · ${row.total_referrals} total</small></td>
                <td><strong>${integer(row.available_earned_coin)} available</strong><small>${integer(row.pending_earned_coin)} pending · ${integer(row.clawed_back_coin)} clawed back</small></td>
                <td><span class="pill ${row.referral_blocked ? 'status-blocked' : row.referral_frozen ? 'status-pending' : 'status-available'}">${row.referral_blocked ? 'Blocked' : row.referral_frozen ? 'Frozen' : 'Active'}</span></td>
                <td><button class="secondary" data-referral-user="${escapeHtml(row.user_id)}">View</button></td>
              </tr>`,
                  )
                  .join('')
          }
        </tbody>
      </table>
    </section>
    <section id="referralDetail"></section>
  `);
  wireShell();

  document
    .querySelector<HTMLFormElement>('#referralSearch')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget as HTMLFormElement);
      void runAction(
        () =>
          listReferrals({
            q: String(values.get('q') ?? ''),
            region_id: String(values.get('region_id') ?? ''),
          }),
        (nextReferrals) => ({
          referralAdmin: data ? { ...data, referrals: nextReferrals } : null,
        }),
      );
    });

  document.querySelectorAll<HTMLFormElement>('[data-referral-region]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const regionId = form.dataset['referralRegion'];
      if (!regionId || !data) return;
      const values = new FormData(form);
      const duration = String(values.get('duration_months') ?? '').trim();
      void runAction(
        () =>
          updateReferralSettings(regionId, {
            enabled: values.get('enabled') === 'on',
            reward_pct: Number(values.get('reward_pct')) / 100,
            hold_hours: Number(values.get('hold_hours')),
            duration_months: duration ? Number(duration) : null,
            milestone_bonus_coin: Number(values.get('milestone_bonus_coin')),
            milestone_bonus_threshold: Number(values.get('milestone_bonus_threshold')),
            credit_immediately: values.get('credit_immediately') === 'on',
          }),
        (updated) => ({
          referralAdmin: {
            ...data,
            settings: data.settings.map((setting) =>
              setting.region_id === updated.region_id ? updated : setting,
            ),
          },
        }),
      );
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-referral-user]').forEach((button) => {
    button.addEventListener('click', () => {
      const userId = button.dataset['referralUser'];
      if (userId) void showReferralDetail(userId);
    });
  });
}

async function showReferralDetail(userId: string): Promise<void> {
  await runAction(() => getReferralDetail(userId), renderReferralDetail);
}

function renderReferralDetail(detail: ReferralDetail): void {
  const target = document.querySelector<HTMLElement>('#referralDetail');
  if (!target) return;
  const canConfigure = state.session?.role === 'superadmin';
  const canReview = canConfigure || state.session?.role === 'reviewer';

  target.innerHTML = `
    <section class="user-detail-header">
      <div><p class="eyebrow">Referral account</p><h3>${escapeHtml(detail.user.email ?? detail.user.id)}</h3><small>${escapeHtml(detail.user.id)}</small></div>
      <span class="pill ${detail.summary.referral_blocked ? 'status-blocked' : detail.summary.referral_frozen ? 'status-pending' : 'status-available'}">${detail.summary.referral_blocked ? 'Blocked' : detail.summary.referral_frozen ? 'Frozen' : detail.user.status}</span>
    </section>
    <section class="metric-grid compact-metrics">
      <article><span>Qualified</span><strong>${detail.summary.qualified_referrals}</strong></article>
      <article><span>Pending users</span><strong>${detail.summary.pending_referrals}</strong></article>
      <article><span>Available coin</span><strong>${integer(detail.summary.available_earned_coin)}</strong></article>
      <article><span>Pending coin</span><strong>${integer(detail.summary.pending_earned_coin)}</strong></article>
    </section>
    <section class="detail-columns">
      <article class="panel">
        <h4>Attribution</h4>
        <dl class="details-grid">
          <dt>Code</dt><dd>${escapeHtml(detail.user.referral_code ?? '—')}</dd>
          <dt>Referrer</dt><dd>${detail.referrer ? `${escapeHtml(detail.referrer.email ?? detail.referrer.id)}<small>${escapeHtml(detail.referrer.referral_code ?? '')}</small>` : 'Organic'}</dd>
          <dt>Applied</dt><dd>${formatDate(detail.user.referred_by_set_at)}</dd>
          <dt>Qualified</dt><dd>${formatDate(detail.user.referral_qualified_at)}</dd>
          <dt>Region</dt><dd>${escapeHtml(detail.user.region_id)}</dd>
          <dt>Net earned</dt><dd>${integer(detail.summary.total_earned_coin)}</dd>
          <dt>Clawed back</dt><dd>${integer(detail.summary.clawed_back_coin)}</dd>
        </dl>
      </article>
      <article class="panel">
        <div class="section-heading"><h4>Code management</h4></div>
        ${
          canConfigure
            ? `<form id="referralCodeForm" class="form-stack compact-form">
          <label>Referral code<input name="code" pattern="HP-[A-HJ-NP-Z2-9]{6}" value="${escapeHtml(detail.user.referral_code ?? '')}" required /></label>
          <label>Reason<input name="reason" minlength="3" maxlength="500" required /></label>
          <div class="form-actions"><button type="submit">Update code</button><button type="button" class="secondary" id="regenerateReferralCode">Regenerate</button></div>
        </form>`
            : `<dl class="details-grid"><dt>Referral code</dt><dd>${escapeHtml(detail.user.referral_code ?? '—')}</dd></dl>`
        }
        ${canReview && detail.summary.referral_frozen ? '<div class="form-actions freeze-action"><button type="button" class="danger" id="clearReferralFreeze">Clear freeze</button></div>' : ''}
      </article>
    </section>
    <section class="panel table-wrap">
      <div class="section-heading"><h4>Invited users</h4><span class="muted">${detail.referred_users.length} shown</span></div>
      <table><thead><tr><th>User</th><th>Status</th><th>Applied</th><th>Qualified</th></tr></thead><tbody>
        ${detail.referred_users.length === 0 ? '<tr><td colspan="4" class="empty-state">No invited users.</td></tr>' : detail.referred_users.map((user) => `<tr><td><strong>${escapeHtml(user.email ?? user.id)}</strong><small>${escapeHtml(user.id)}</small></td><td><span class="pill ${user.referral_qualified_at ? 'status-available' : 'status-pending'}">${user.referral_qualified_at ? 'Qualified' : 'Pending'}</span></td><td>${formatDate(user.referred_by_set_at)}</td><td>${formatDate(user.referral_qualified_at)}</td></tr>`).join('')}
      </tbody></table>
    </section>
    <section class="panel table-wrap">
      <div class="section-heading"><h4>Referral earnings</h4><span class="muted">Latest 50</span></div>
      <table><thead><tr><th>Type</th><th>Amount</th><th>State</th><th>Release</th><th>Source event</th><th>Created</th></tr></thead><tbody>
        ${detail.recent_earnings.length === 0 ? '<tr><td colspan="6" class="empty-state">No referral earnings.</td></tr>' : detail.recent_earnings.map((entry) => `<tr><td>${escapeHtml(entry.entry_type)}</td><td>${integer(entry.amount)}</td><td><span class="pill ${entry.state === 'available' ? 'status-available' : entry.state === 'clawed_back' ? 'status-blocked' : 'status-pending'}">${entry.state === 'clawed_back' ? 'Clawed back' : entry.state.charAt(0).toUpperCase() + entry.state.slice(1)}</span></td><td>${formatDate(entry.hold_until)}</td><td><small>${escapeHtml(entry.source_event_id ?? '—')}</small></td><td>${formatDate(entry.created_at)}</td></tr>`).join('')}
      </tbody></table>
    </section>
  `;

  target
    .querySelector<HTMLFormElement>('#referralCodeForm')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget as HTMLFormElement);
      void runAction(
        () =>
          updateReferralCode(
            detail.user.id,
            String(values.get('code') ?? '')
              .trim()
              .toUpperCase(),
            String(values.get('reason') ?? '').trim(),
          ),
        renderReferralDetail,
      );
    });
  target
    .querySelector<HTMLButtonElement>('#regenerateReferralCode')
    ?.addEventListener('click', () => {
      const reason = window.prompt('Reason for regenerating this referral code');
      if (reason)
        void runAction(() => regenerateReferralCode(detail.user.id, reason), renderReferralDetail);
    });
  target.querySelector<HTMLButtonElement>('#clearReferralFreeze')?.addEventListener('click', () => {
    const reason = window.prompt('Reason for clearing this referral freeze');
    if (reason)
      void runAction(() => clearReferralFreeze(detail.user.id, reason), renderReferralDetail);
  });
}

function usersRequest(query = state.userQuery): Promise<PagedResponse<AdminUserSummary>> {
  return listUsers({
    // Sent only when set: an empty q would otherwise be matched against as a real search term.
    ...(query.q ? { q: query.q } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
}

function userQueryWithoutCursor(): AppState['userQuery'] {
  return { q: state.userQuery.q, status: state.userQuery.status };
}

const USER_STATUS_OPTIONS: Array<[string, string]> = [
  ['', 'Any status'],
  ['active', 'Active'],
  ['suspended', 'Suspended'],
  ['banned', 'Banned'],
];

function renderUsers(data?: PagedResponse<AdminUserSummary>): void {
  const rows = data?.items ?? [];
  const pageNumber = state.userHistory.length + 1;
  appRoot.innerHTML = shell(`
    <section class="page-header">
      <div>
        <p class="eyebrow">Customers</p>
        <h2>Users</h2>
      </div>
      <form id="userSearch" class="inline-form">
        <input name="q" placeholder="ID, username, email, referral code" value="${escapeHtml(state.userQuery.q)}" />
        <select name="status">
          ${USER_STATUS_OPTIONS.map(
            ([value, label]) =>
              `<option value="${value}" ${state.userQuery.status === value ? 'selected' : ''}>${label}</option>`,
          ).join('')}
        </select>
        <button type="submit">Search</button>
      </form>
    </section>
    <section class="panel table-wrap">
      <table>
        <thead><tr><th>User</th><th>Status</th><th>Region</th><th>Wallet</th><th>Fraud</th><th></th></tr></thead>
        <tbody>
          ${
            rows.length > 0
              ? rows
                  .map(
                    (user) => `<tr>
                <td><strong>${escapeHtml(user.email ?? user.id)}</strong><small>${escapeHtml(user.id)}</small></td>
                <td><span class="pill">${escapeHtml(user.status)}</span></td>
                <td>${escapeHtml(user.region_id)} / ${escapeHtml(user.country_code)}</td>
                <td>${escapeHtml(user.wallet.available_coin)}</td>
                <td>${user.fraud_score} · ${user.open_flag_count} open</td>
                <td><button class="secondary" data-user-id="${escapeHtml(user.id)}">View</button></td>
              </tr>`,
                  )
                  .join('')
              : '<tr><td colspan="6" class="empty-state">No users match these filters.</td></tr>'
          }
        </tbody>
      </table>
      <div class="monitor-pagination">
        <span>Page ${pageNumber} · up to 50 users per page</span>
        <div class="row-actions">
          <button type="button" class="secondary" id="previousUserPage" ${state.userHistory.length === 0 ? 'disabled' : ''}>Previous</button>
          <button type="button" class="secondary" id="nextUserPage" ${data?.next_cursor ? '' : 'disabled'}>Next</button>
        </div>
      </div>
    </section>
    <section id="detailPanel"></section>
  `);
  wireShell();
  document.querySelector<HTMLFormElement>('#userSearch')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    // A new search restarts paging: the old cursors point into a result set that no longer exists.
    state.userQuery = {
      q: String(form.get('q') ?? '').trim(),
      status: String(form.get('status') ?? ''),
    };
    state.userHistory = [];
    void runAction(
      () => usersRequest(),
      (users) => ({ users }),
    );
  });
  document.querySelector<HTMLButtonElement>('#nextUserPage')?.addEventListener('click', () => {
    if (!data?.next_cursor) return;
    state.userHistory.push(state.userQuery.cursor ?? '');
    state.userQuery = { ...state.userQuery, cursor: data.next_cursor };
    void runAction(
      () => usersRequest(),
      (users) => ({ users }),
    );
  });
  document.querySelector<HTMLButtonElement>('#previousUserPage')?.addEventListener('click', () => {
    const cursor = state.userHistory.pop();
    if (cursor === undefined) return;
    const baseQuery = userQueryWithoutCursor();
    state.userQuery = cursor ? { ...baseQuery, cursor } : baseQuery;
    void runAction(
      () => usersRequest(),
      (users) => ({ users }),
    );
  });
  document.querySelectorAll<HTMLButtonElement>('[data-user-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset['userId'];
      if (id) void showUserDetail(id);
    });
  });
}

async function showUserDetail(id: string): Promise<void> {
  await runAction(async () => getUser(id), renderUserDetail);
}

function renderUserDetail(user: AdminUserDetail): void {
  const target = document.querySelector<HTMLElement>('#detailPanel');
  if (!target) return;
  const canManage = state.session?.role === 'superadmin';
  const credentials = [
    ...user.identities.map((identity) => ({
      provider: identity.provider as 'guest' | 'google' | 'facebook',
      label: identity.email ?? identity.provider,
      verifiedAt: identity.email_verified_at,
      lastUsedAt: identity.last_used_at,
      disabledAt: identity.disabled_at,
    })),
    ...(user.password_credential
      ? [
          {
            provider: 'password' as const,
            label: `${user.password_credential.username} · ${user.password_credential.email}`,
            verifiedAt: user.password_credential.email_verified_at,
            lastUsedAt: user.password_credential.password_changed_at,
            disabledAt: user.password_credential.disabled_at,
          },
        ]
      : []),
  ];

  target.innerHTML = `
    <section class="user-detail-header">
      <div>
        <p class="eyebrow">Account workspace</p>
        <h3>${escapeHtml(user.email ?? user.id)}</h3>
        <small>${escapeHtml(user.id)}</small>
      </div>
      <span class="pill">${escapeHtml(user.status)}</span>
    </section>
    <section class="metric-grid compact-metrics">
      <article><span>Available coin</span><strong>${escapeHtml(user.wallet.available_coin)}</strong></article>
      <article><span>Lifetime earned</span><strong>${escapeHtml(user.wallet.lifetime_earned)}</strong></article>
      <article><span>Active sessions</span><strong>${user.active_sessions.length}</strong></article>
      <article><span>Welcome credit</span><strong>${user.welcome_credit.granted ? escapeHtml(user.welcome_credit.amount) : 'Missing'}</strong></article>
    </section>
    <section class="detail-columns">
      <article class="panel">
        <h4>Overview</h4>
        <dl class="details-grid">
          <dt>Primary login</dt><dd>${escapeHtml(user.auth_provider)}</dd>
          <dt>Region</dt><dd>${escapeHtml(user.region_id)} / ${escapeHtml(user.country_code)}</dd>
          <dt>Trust</dt><dd>${user.trust_level}</dd>
          <dt>Fraud score</dt><dd>${user.fraud_score} · ${user.open_flag_count} open</dd>
          <dt>Referral</dt><dd>${escapeHtml(user.referral_code ?? '—')}</dd>
          <dt>Created</dt><dd>${formatDate(user.created_at)}</dd>
          <dt>Welcome granted</dt><dd>${formatDate(user.welcome_credit.granted_at)}</dd>
        </dl>
      </article>
      <article class="panel">
        <div class="section-heading">
          <h4>Login methods</h4>
        </div>
        <div class="record-list">
          ${
            credentials.length === 0
              ? '<p class="muted">No login methods.</p>'
              : credentials
                  .map(
                    (credential) => `<div class="record-row">
                <div><strong>${escapeHtml(credential.provider)}</strong><span>${escapeHtml(credential.label)}</span><small>${credential.disabledAt ? `Disabled ${formatDate(credential.disabledAt)}` : credential.verifiedAt ? `Verified ${formatDate(credential.verifiedAt)}` : 'Email not verified'} · Last activity ${formatDate(credential.lastUsedAt)}</small></div>
                ${canManage && !credential.disabledAt ? `<button class="secondary compact-button" data-disable-credential="${escapeHtml(credential.provider)}">Disable</button>` : ''}
              </div>`,
                  )
                  .join('')
          }
        </div>
      </article>
    </section>
    <section class="panel">
      <div class="section-heading">
        <h4>Active sessions</h4>
        ${canManage && user.active_sessions.length > 0 ? '<button class="danger compact-button" id="revokeAllSessions">Revoke all</button>' : ''}
      </div>
      <div class="table-wrap">
        <table><thead><tr><th>Login</th><th>Device</th><th>IP</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody>
          ${
            user.active_sessions.length === 0
              ? '<tr><td colspan="6" class="muted">No active sessions.</td></tr>'
              : user.active_sessions
                  .map(
                    (session) =>
                      `<tr><td>${escapeHtml(session.provider)}</td><td>${escapeHtml(session.device_id ?? session.user_agent ?? '—')}</td><td>${escapeHtml(session.ip ?? '—')}</td><td>${formatDate(session.last_used_at)}</td><td>${formatDate(session.expires_at)}</td><td>${canManage ? `<button class="secondary compact-button" data-revoke-session="${escapeHtml(session.id)}">Revoke</button>` : ''}</td></tr>`,
                  )
                  .join('')
          }
        </tbody></table>
      </div>
    </section>
    ${canManage ? `<section class="panel"><div class="section-heading"><div><h4>Grant coin</h4><p class="muted">Add coin directly to the available wallet balance.</p></div></div><form id="coinGrantForm" class="inline-form adjustment-form"><div class="amount-control"><label>Amount<input name="amount" type="number" min="1" max="100000" step="1" placeholder="1–100,000" required /></label><button id="maxCoinGrant" class="secondary" type="button" title="Set maximum grant amount">Max</button></div><label>Reason<input name="reason" minlength="3" maxlength="500" placeholder="Required for audit log" required /></label><button type="submit">Grant coin</button></form><p id="coinGrantResult" class="form-result" role="status" aria-live="polite"></p><details class="advanced-adjustment"><summary>Advanced coin adjustment</summary><form id="coinAdjustmentForm" class="inline-form adjustment-form"><label>Signed amount<input name="amount" type="number" min="-100000" max="100000" step="1" placeholder="For example, -500" required /></label><label>Reason<input name="reason" minlength="3" maxlength="500" placeholder="Required for audit log" required /></label><button class="secondary" type="submit">Apply adjustment</button></form></details></section>` : ''}
    <section class="panel table-wrap">
      <h4>Recent ledger</h4>
      <table><thead><tr><th>Type</th><th>Amount</th><th>Bucket</th><th>Balance</th><th>Note</th><th>Time</th></tr></thead><tbody>
        ${user.ledger.length === 0 ? '<tr><td colspan="6" class="muted">No ledger entries.</td></tr>' : user.ledger.map((entry) => `<tr><td>${escapeHtml(entry.entry_type)}</td><td>${escapeHtml(entry.amount)}</td><td>${escapeHtml(entry.bucket)}</td><td>${escapeHtml(entry.balance_after)}</td><td>${escapeHtml(entry.note ?? '—')}</td><td>${formatDate(entry.created_at)}</td></tr>`).join('')}
      </tbody></table>
    </section>
    <section class="detail-columns">
      <article class="panel table-wrap"><h4>Authentication events</h4><table><thead><tr><th>Event</th><th>Result</th><th>IP / device</th><th>Time</th></tr></thead><tbody>
        ${user.auth_events.length === 0 ? '<tr><td colspan="4" class="muted">No authentication events.</td></tr>' : user.auth_events.map((event) => `<tr><td><strong>${escapeHtml(event.event_type)}</strong><small>${escapeHtml(event.provider)}</small></td><td>${escapeHtml(event.outcome)}${event.failure_code ? `<small>${escapeHtml(event.failure_code)}</small>` : ''}</td><td>${escapeHtml(event.ip ?? '—')}<small>${escapeHtml(event.device_id ?? '')}</small></td><td>${formatDate(event.created_at)}</td></tr>`).join('')}
      </tbody></table></article>
      <article class="panel"><h4>Admin audit</h4>${auditList(user.admin_audit.map((entry) => ({ ...entry, target_type: 'user', target_id: user.id, ip: null })))}</article>
    </section>
  `;

  target.querySelectorAll<HTMLButtonElement>('[data-revoke-session]').forEach((button) => {
    button.addEventListener('click', () => {
      const sessionId = button.dataset['revokeSession'];
      const reason = window.prompt('Reason for revoking this session');
      if (sessionId && reason)
        void runAction(() => revokeUserSession(user.id, sessionId, reason), renderUserDetail);
    });
  });
  target.querySelector<HTMLButtonElement>('#revokeAllSessions')?.addEventListener('click', () => {
    const reason = window.prompt('Reason for revoking all sessions');
    if (reason) void runAction(() => revokeAllUserSessions(user.id, reason), renderUserDetail);
  });
  target.querySelectorAll<HTMLButtonElement>('[data-disable-credential]').forEach((button) => {
    button.addEventListener('click', () => {
      const provider = button.dataset['disableCredential'] as
        'guest' | 'google' | 'facebook' | 'password' | undefined;
      const reason = window.prompt(`Reason for disabling ${provider ?? 'this'} login`);
      if (provider && reason)
        void runAction(() => disableUserCredential(user.id, provider, reason), renderUserDetail);
    });
  });
  target.querySelector<HTMLButtonElement>('#maxCoinGrant')?.addEventListener('click', () => {
    const amountInput = target.querySelector<HTMLInputElement>(
      '#coinGrantForm input[name="amount"]',
    );
    const reasonInput = target.querySelector<HTMLInputElement>(
      '#coinGrantForm input[name="reason"]',
    );
    if (amountInput) amountInput.value = '100000';
    reasonInput?.focus();
  });
  target.querySelector<HTMLFormElement>('#coinGrantForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget as HTMLFormElement);
    const amount = Number(values.get('amount'));
    const reason = String(values.get('reason') ?? '').trim();
    if (!Number.isInteger(amount) || amount < 1 || amount > 100_000 || reason.length < 3) return;
    if (!window.confirm(`Grant ${integer(amount)} coin directly to ${user.email ?? user.id}?`))
      return;
    const idempotencyKey = globalThis.crypto.randomUUID();
    void runAction(
      () => grantUserCoin(user.id, amount, reason, idempotencyKey),
      async (result) => {
        renderUserDetail(await getUser(user.id));
        const message = document.querySelector<HTMLElement>('#coinGrantResult');
        if (message) {
          message.textContent = `Granted ${integer(result.amount_coin)} coin. New available balance: ${integer(result.new_balance)}.`;
        }
      },
    );
  });
  target
    .querySelector<HTMLFormElement>('#coinAdjustmentForm')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget as HTMLFormElement);
      const amount = Number(values.get('amount'));
      const reason = String(values.get('reason') ?? '').trim();
      if (
        !Number.isInteger(amount) ||
        amount === 0 ||
        amount < -100_000 ||
        amount > 100_000 ||
        reason.length < 3
      )
        return;
      if (!window.confirm(`Apply a ${integer(amount)} coin adjustment to this user?`)) return;
      const idempotencyKey = globalThis.crypto.randomUUID();
      void runAction(
        () => adjustUserCoin(user.id, amount, reason, idempotencyKey),
        async () => renderUserDetail(await getUser(user.id)),
      );
    });
}

/** /admin/catalog admits fulfillment and superadmin only; a reviewer gets 403 from it. */
function canManageCatalog(): boolean {
  return state.session?.role === 'fulfillment' || state.session?.role === 'superadmin';
}

function catalogRequest(query = state.catalogQuery): Promise<PagedResponse<CatalogItemAdmin>> {
  return listCatalogItems({
    ...(query.is_active ? { is_active: query.is_active } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
}

const CATALOG_FILTERS: Array<[string, string]> = [
  ['', 'All items'],
  ['true', 'Active only'],
  ['false', 'Inactive only'],
];

function catalogEditor(item?: CatalogItemAdmin): string {
  const isEditing = Boolean(item);
  return `<article class="panel offer-editor">
    <div class="section-heading">
      <div>
        <p class="eyebrow">${isEditing ? 'Edit reward' : 'New reward'}</p>
        <h3>${escapeHtml(item?.title ?? 'Create catalog item')}</h3>
      </div>
      <button class="secondary icon-button" type="button" id="closeCatalogEditor" aria-label="Close editor" title="Close editor">×</button>
    </div>
    <form id="catalogForm" class="form-grid">
      ${
        isEditing
          ? // sku and category are create-only server-side, so they are shown as context rather than
            // as inputs that would silently discard an edit.
            `<p class="muted field-wide">SKU <code>${escapeHtml(item?.sku)}</code> · category <code>${escapeHtml(item?.category)}</code> · source ${escapeHtml(item?.source)} — these cannot be changed after creation.</p>`
          : `<label>SKU<input name="sku" value="" placeholder="steam-vn-5usd" required /></label>
             <label>Category<input name="category" value="" placeholder="gift_card" required /></label>`
      }
      <label>Title<input name="title" value="${escapeHtml(item?.title ?? '')}" required /></label>
      <label>Face value<input name="face_value" value="${escapeHtml(item?.face_value ?? '')}" placeholder="$5" required /></label>
      <label>Coin price<input name="coin_price" type="number" min="0" step="1" value="${escapeHtml(item?.coin_price ?? '')}" required /></label>
      <label>Supplier cost (USD)<input name="usd_cost" type="number" min="0" step="0.01" value="${escapeHtml(item?.usd_cost ?? '')}" required /><small>Never sent to the app.</small></label>
      <label>Regions<input name="regions" value="${escapeHtml((item?.regions ?? []).join(', '))}" placeholder="VN, US" required /><small>Two-letter codes, comma separated.</small></label>
      <label>Image URL<input name="image_url" type="url" value="${escapeHtml(item?.image_url ?? '')}" /></label>
      <label>Supplier URL<input name="seagm_url" type="url" value="${escapeHtml(item?.seagm_url ?? '')}" /></label>
      <label class="field-wide">Stock note<input name="stock_note" value="${escapeHtml(item?.stock_note ?? '')}" placeholder="Out of stock until Friday" /></label>
      <label class="switch-label field-wide"><input name="is_active" type="checkbox" ${item?.is_active ? 'checked' : ''} /><span><strong>Listed for exchange</strong><small>Unlisted items stay in the catalog but users cannot redeem them.</small></span></label>
      <div class="form-actions field-wide">
        <button type="submit">${isEditing ? 'Save reward' : 'Create reward'}</button>
        ${isEditing ? `<span class="muted">Updated ${formatDate(item?.updated_at ?? null)}</span>` : '<span class="muted">New items are created unlisted — activate when the stock is confirmed.</span>'}
      </div>
    </form>
  </article>`;
}

function catalogSection(): string {
  if (!canManageCatalog()) {
    return `<section class="panel"><p class="muted">The reward catalog is managed by fulfillment and superadmin roles. Your role can review redemption requests but not edit what is listed.</p></section>`;
  }
  const items = state.catalog?.items ?? [];
  const editing = state.creatingCatalogItem
    ? catalogEditor()
    : state.editingCatalogId
      ? catalogEditor(items.find((item) => item.id === state.editingCatalogId))
      : '';

  return `
    <section class="toolbar-row">
      <form id="catalogFilter" class="inline-form">
        <select name="is_active">
          ${CATALOG_FILTERS.map(
            ([value, label]) =>
              `<option value="${value}" ${state.catalogQuery.is_active === value ? 'selected' : ''}>${label}</option>`,
          ).join('')}
        </select>
        <button type="submit">Filter</button>
      </form>
      <button type="button" id="newCatalogItem">New reward</button>
    </section>
    ${editing}
    <section class="panel table-wrap">
      <table>
        <thead><tr><th>Reward</th><th>Coin price</th><th>Cost</th><th>Regions</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${
            items.length > 0
              ? items
                  .map(
                    (item) => `<tr>
                <td><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.face_value)} · ${escapeHtml(item.sku)}</small></td>
                <td>${integer(item.coin_price)}</td>
                <td>${money(Number(item.usd_cost))}</td>
                <td>${escapeHtml(item.regions.join(', ') || '—')}</td>
                <td><span class="pill">${item.is_active ? 'listed' : 'unlisted'}</span>${item.stock_note ? `<small>${escapeHtml(item.stock_note)}</small>` : ''}</td>
                <td class="row-actions">
                  <button class="secondary" data-catalog-edit="${escapeHtml(item.id)}">Edit</button>
                  <button class="secondary" data-catalog-toggle="${escapeHtml(item.id)}">${item.is_active ? 'Unlist' : 'List'}</button>
                </td>
              </tr>`,
                  )
                  .join('')
              : '<tr><td colspan="6" class="empty-state">No catalog items match this filter.</td></tr>'
          }
        </tbody>
      </table>
      <div class="monitor-pagination">
        <span>Page ${state.catalogHistory.length + 1} · up to 50 rewards per page</span>
        <div class="row-actions">
          <button type="button" class="secondary" id="previousCatalogPage" ${state.catalogHistory.length === 0 ? 'disabled' : ''}>Previous</button>
          <button type="button" class="secondary" id="nextCatalogPage" ${state.catalog?.next_cursor ? '' : 'disabled'}>Next</button>
        </div>
      </div>
    </section>`;
}

// Everything the form can set. sku and category live outside it because the server accepts them
// only at creation, so a full object here is valid as both a create payload (plus those two) and an
// update payload (which is a Partial of it).
type CatalogFormFields = Omit<CreateCatalogItemInput, 'sku' | 'category'>;

function catalogFormInput(form: HTMLFormElement): CatalogFormFields {
  const values = new FormData(form);
  const text = (key: string): string => String(values.get(key) ?? '').trim();
  return {
    title: text('title'),
    face_value: text('face_value'),
    coin_price: Number(values.get('coin_price')),
    usd_cost: Number(values.get('usd_cost')),
    regions: text('regions')
      .split(',')
      .map((region) => region.trim().toUpperCase())
      .filter(Boolean),
    // Optional strings are omitted rather than sent empty: the server treats a present key as an
    // intentional value, and "" is not the same as "leave it alone".
    ...(text('image_url') ? { image_url: text('image_url') } : {}),
    ...(text('seagm_url') ? { seagm_url: text('seagm_url') } : {}),
    ...(text('stock_note') ? { stock_note: text('stock_note') } : {}),
    is_active: values.get('is_active') === 'on',
  };
}

function wireCatalog(): void {
  document.querySelector<HTMLFormElement>('#catalogFilter')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    state.catalogQuery = { is_active: String(form.get('is_active') ?? '') };
    state.catalogHistory = [];
    void runAction(
      () => catalogRequest(),
      (catalog) => ({ catalog }),
    );
  });
  document.querySelector<HTMLButtonElement>('#newCatalogItem')?.addEventListener('click', () => {
    setState({ creatingCatalogItem: true, editingCatalogId: null });
  });
  document
    .querySelector<HTMLButtonElement>('#closeCatalogEditor')
    ?.addEventListener('click', () => {
      setState({ creatingCatalogItem: false, editingCatalogId: null });
    });
  document.querySelectorAll<HTMLButtonElement>('[data-catalog-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      setState({
        editingCatalogId: button.dataset['catalogEdit'] ?? null,
        creatingCatalogItem: false,
      });
    });
  });
  // The one-click lever this page exists for: pulling a reward out of the app without opening a form.
  document.querySelectorAll<HTMLButtonElement>('[data-catalog-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset['catalogToggle'];
      const item = state.catalog?.items.find((entry) => entry.id === id);
      if (!id || !item) return;
      void runAction(
        () => updateCatalogItem(id, { is_active: !item.is_active }),
        () => refreshCatalog(),
      );
    });
  });
  document.querySelector<HTMLFormElement>('#catalogForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = catalogFormInput(form);
    const editingId = state.editingCatalogId;
    void runAction(
      async () => {
        if (editingId) {
          await updateCatalogItem(editingId, input);
        } else {
          const values = new FormData(form);
          await createCatalogItem({
            ...input,
            sku: String(values.get('sku') ?? '').trim(),
            category: String(values.get('category') ?? '').trim(),
          });
        }
        return refreshCatalog();
      },
      (next) => next,
    );
  });
  document.querySelector<HTMLButtonElement>('#nextCatalogPage')?.addEventListener('click', () => {
    const cursor = state.catalog?.next_cursor;
    if (!cursor) return;
    state.catalogHistory.push(state.catalogQuery.cursor ?? '');
    state.catalogQuery = { ...state.catalogQuery, cursor };
    void runAction(
      () => catalogRequest(),
      (catalog) => ({ catalog }),
    );
  });
  document
    .querySelector<HTMLButtonElement>('#previousCatalogPage')
    ?.addEventListener('click', () => {
      const cursor = state.catalogHistory.pop();
      if (cursor === undefined) return;
      const base = { is_active: state.catalogQuery.is_active };
      state.catalogQuery = cursor ? { ...base, cursor } : base;
      void runAction(
        () => catalogRequest(),
        (catalog) => ({ catalog }),
      );
    });
}

/** Re-reads the current page so a save is reflected in the row, and closes the editor. */
async function refreshCatalog(): Promise<Partial<AppState>> {
  return { catalog: await catalogRequest(), editingCatalogId: null, creatingCatalogItem: false };
}

function renderRedemptions(data?: PagedResponse<AdminRedemptionSummary>): void {
  const statuses = [
    '',
    'REQUESTED',
    'FRAUD_REVIEW',
    'APPROVED',
    'PURCHASING',
    'DELIVERED',
    'REJECTED',
    'FAILED',
  ];
  const onRequests = state.redemptionsTab === 'requests';
  const tabs: Array<[RedemptionsTab, string]> = [
    ['requests', 'Requests'],
    ['catalog', 'Reward catalog'],
  ];
  const requestsSection = `
    <section class="toolbar-row">
      <form id="redemptionFilter" class="inline-form">
        <select name="status">${statuses.map((status) => `<option value="${status}" ${state.redemptionStatus === status ? 'selected' : ''}>${status || 'Any status'}</option>`).join('')}</select>
        <button type="submit">Filter</button>
      </form>
    </section>
    <section class="panel table-wrap">
      <table>
        <thead><tr><th>User</th><th>Reward</th><th>Status</th><th>Coin price</th><th>Created</th><th></th></tr></thead>
        <tbody>
          ${(data?.items ?? [])
            .map(
              (redemption) => `<tr>
                <td><strong>${escapeHtml(redemption.user.email ?? redemption.user.id)}</strong><small>${escapeHtml(redemption.user.id)}</small></td>
                <td><strong>${escapeHtml(redemption.reward.title)}</strong><small>${escapeHtml(redemption.reward.face_value)} · ${escapeHtml(redemption.reward.sku)}</small></td>
                <td><span class="pill">${escapeHtml(redemption.status)}</span></td>
                <td>${integer(redemption.coin_price)}</td>
                <td>${formatDate(redemption.created_at)}</td>
                <td><button class="secondary" data-redemption-id="${escapeHtml(redemption.id)}">View</button></td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </section>
    <section id="redemptionDetail"></section>`;

  appRoot.innerHTML = shell(`
    <section class="page-header">
      <div>
        <p class="eyebrow">Fulfillment</p>
        <h2>Redemptions</h2>
      </div>
    </section>
    <div class="tab-bar">${tabs
      .map(
        ([tab, label]) =>
          `<button class="tab-button ${state.redemptionsTab === tab ? 'active' : ''}" type="button" data-redemptions-tab="${tab}">${label}</button>`,
      )
      .join('')}</div>
    ${onRequests ? requestsSection : catalogSection()}
  `);
  wireShell();
  document.querySelectorAll<HTMLButtonElement>('[data-redemptions-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const tab = button.dataset['redemptionsTab'] as RedemptionsTab;
      // The catalog is fetched on first visit rather than with the page, so a reviewer who can only
      // see requests never issues a call that would 403.
      if (tab === 'catalog' && !state.catalog && canManageCatalog()) {
        state.redemptionsTab = tab;
        void runAction(
          () => catalogRequest(),
          (catalog) => ({ catalog }),
        );
        return;
      }
      setState({ redemptionsTab: tab });
    });
  });

  if (!onRequests) {
    wireCatalog();
    return;
  }

  document
    .querySelector<HTMLFormElement>('#redemptionFilter')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget as HTMLFormElement);
      const status = String(form.get('status') ?? '');
      state.redemptionStatus = status;
      void runAction(
        async () => listRedemptions({ status }),
        (redemptions) => ({ redemptions }),
      );
    });
  document.querySelectorAll<HTMLButtonElement>('[data-redemption-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset['redemptionId'];
      if (id) void showRedemptionDetail(id);
    });
  });
}

async function showRedemptionDetail(id: string): Promise<void> {
  await runAction(async () => getRedemption(id), renderRedemptionDetail);
}

function renderRedemptionDetail(detail: RedemptionDetail): void {
  const target = document.querySelector<HTMLElement>('#redemptionDetail');
  if (!target) return;
  const canReview = state.session?.role === 'reviewer' || state.session?.role === 'superadmin';
  const canFulfill = state.session?.role === 'fulfillment' || state.session?.role === 'superadmin';
  const canApprove = canReview && ['REQUESTED', 'FRAUD_REVIEW'].includes(detail.redemption.status);
  const canStartFulfillment = canFulfill && detail.redemption.status === 'APPROVED';
  const canDeliver = canFulfill && detail.redemption.status === 'PURCHASING';
  const canReject =
    canReview &&
    ['REQUESTED', 'FRAUD_REVIEW', 'APPROVED', 'PURCHASING'].includes(detail.redemption.status);
  target.innerHTML = `
    <article class="panel">
      <div class="section-heading"><div><p class="eyebrow">Fulfillment task</p><h3>${escapeHtml(detail.redemption.reward.title)}</h3><small>${escapeHtml(detail.redemption.id)}</small></div><span class="pill">${escapeHtml(detail.redemption.status)}</span></div>
      <div class="two-column">
        <dl class="details-grid">
          <dt>User</dt><dd>${escapeHtml(detail.user.email ?? detail.user.id)}<small>${escapeHtml(detail.user.id)}</small></dd>
          <dt>Reward</dt><dd>${escapeHtml(detail.redemption.reward.title)} · ${escapeHtml(detail.redemption.reward.face_value)}</dd>
          <dt>SKU</dt><dd>${escapeHtml(detail.redemption.reward.sku)}</dd>
          <dt>Coin charged</dt><dd>${integer(detail.redemption.coin_price)}</dd>
          <dt>Estimated cost</dt><dd>${money(Number(detail.redemption.usd_cost_est))}</dd>
          <dt>Region</dt><dd>${escapeHtml(detail.user.region_id)} / ${escapeHtml(detail.user.country_code)}</dd>
          <dt>Fraud score</dt><dd>${detail.user.fraud_score}</dd>
          <dt>Delivered</dt><dd>${formatDate(detail.redemption.delivered_at)}</dd>
          <dt>User received</dt><dd>${detail.redemption.claimed_at ? formatDate(detail.redemption.claimed_at) : 'Not viewed'}</dd>
        </dl>
        <div class="action-stack">
          ${detail.catalog_item.seagm_url && canFulfill ? `<a class="button-link secondary" href="${escapeHtml(detail.catalog_item.seagm_url)}" target="_blank" rel="noopener noreferrer">Open supplier</a>` : ''}
          ${canApprove ? `<button data-approve="${escapeHtml(detail.redemption.id)}">Approve</button>` : ''}
          ${canStartFulfillment ? `<button data-fulfill="${escapeHtml(detail.redemption.id)}">Start purchasing</button>` : ''}
          ${canDeliver ? '<button id="openDeliveryDialog">Deliver reward</button>' : ''}
          ${canReject ? `<button class="danger" data-reject="${escapeHtml(detail.redemption.id)}">Cancel & refund</button>` : ''}
          ${!canApprove && !canStartFulfillment && !canDeliver && !canReject ? '<span class="muted">No actions available.</span>' : ''}
        </div>
      </div>
      <h4>Status history</h4>
      <ul class="timeline">
        ${detail.history
          .map((entry) => {
            const showNote = entry.note && !['APPROVED', 'PURCHASING'].includes(entry.to_status);
            return `<li><strong>${escapeHtml(entry.from_status ?? 'START')} → ${escapeHtml(entry.to_status)}</strong><span>${escapeHtml(entry.actor)} · ${formatDate(entry.created_at)}</span>${showNote ? `<p>${escapeHtml(entry.note)}</p>` : ''}</li>`;
          })
          .join('')}
      </ul>
    </article>
    ${canApprove || canStartFulfillment ? `<dialog id="redemptionActionDialog" aria-labelledby="redemptionActionTitle"><div class="form-stack"><div><p class="eyebrow">Confirm action</p><h3 id="redemptionActionTitle"></h3><p id="redemptionActionMessage" class="muted"></p></div><div class="form-actions"><button id="confirmRedemptionAction" type="button"></button><button id="cancelRedemptionAction" class="secondary" type="button">Cancel</button></div></div></dialog>` : ''}
    ${canDeliver ? `<dialog id="deliveryDialog"><form id="deliveryCodeForm" class="form-stack"><div><p class="eyebrow">Complete fulfillment</p><h3>Deliver ${escapeHtml(detail.redemption.reward.title)}</h3><p class="muted">${escapeHtml(detail.user.email ?? detail.user.id)} · ${escapeHtml(detail.redemption.reward.face_value)}</p></div><label>Delivery code<textarea name="delivery_code" rows="4" minlength="1" maxlength="4000" autocomplete="off" required></textarea></label><label>Delivery note<textarea name="note" rows="2" maxlength="2000" placeholder="Optional instructions for the user"></textarea></label><div class="form-actions"><button type="submit">Deliver reward</button><button id="cancelDelivery" class="secondary" type="button">Cancel</button></div></form></dialog>` : ''}
  `;
  const actionDialog = target.querySelector<HTMLDialogElement>('#redemptionActionDialog');
  const actionTitle = target.querySelector<HTMLElement>('#redemptionActionTitle');
  const actionMessage = target.querySelector<HTMLElement>('#redemptionActionMessage');
  const confirmActionButton = target.querySelector<HTMLButtonElement>('#confirmRedemptionAction');
  let pendingAction: (() => Promise<unknown>) | null = null;
  const openActionDialog = (
    title: string,
    message: string,
    confirmLabel: string,
    action: () => Promise<unknown>,
  ): void => {
    if (!actionDialog || !actionTitle || !actionMessage || !confirmActionButton) return;
    actionTitle.textContent = title;
    actionMessage.textContent = message;
    confirmActionButton.textContent = confirmLabel;
    pendingAction = action;
    actionDialog.showModal();
  };
  target.querySelector<HTMLButtonElement>('[data-approve]')?.addEventListener('click', () => {
    openActionDialog(
      'Approve redemption?',
      `Approve ${detail.redemption.reward.title} for ${detail.user.email ?? detail.user.id}?`,
      'Approve',
      () => approveRedemption(detail.redemption.id),
    );
  });
  target.querySelector<HTMLButtonElement>('[data-fulfill]')?.addEventListener('click', () => {
    openActionDialog(
      'Start purchasing?',
      `Move ${detail.redemption.reward.title} to the purchasing queue?`,
      'Start purchasing',
      () => fulfillRedemption(detail.redemption.id),
    );
  });
  target
    .querySelector<HTMLButtonElement>('#cancelRedemptionAction')
    ?.addEventListener('click', () => {
      pendingAction = null;
      actionDialog?.close();
    });
  confirmActionButton?.addEventListener('click', () => {
    const action = pendingAction;
    pendingAction = null;
    actionDialog?.close();
    if (!action) return;
    void runAction(action, async () =>
      renderRedemptionDetail(await getRedemption(detail.redemption.id)),
    );
  });
  target.querySelector<HTMLButtonElement>('[data-reject]')?.addEventListener('click', () => {
    const reason = window.prompt('Reject reason');
    if (reason)
      void runAction(
        async () => rejectRedemption(detail.redemption.id, reason),
        async () => renderRedemptionDetail(await getRedemption(detail.redemption.id)),
      );
  });
  const deliveryDialog = target.querySelector<HTMLDialogElement>('#deliveryDialog');
  target.querySelector<HTMLButtonElement>('#openDeliveryDialog')?.addEventListener('click', () => {
    deliveryDialog?.showModal();
  });
  target.querySelector<HTMLButtonElement>('#cancelDelivery')?.addEventListener('click', () => {
    deliveryDialog?.close();
  });
  target
    .querySelector<HTMLFormElement>('#deliveryCodeForm')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget as HTMLFormElement);
      const deliveryCode = String(values.get('delivery_code') ?? '').trim();
      const note = String(values.get('note') ?? '').trim() || undefined;
      if (!deliveryCode) return;
      deliveryDialog?.close();
      void runAction(
        () => pasteRedemptionCode(detail.redemption.id, deliveryCode, note),
        async () => renderRedemptionDetail(await getRedemption(detail.redemption.id)),
      );
    });
}

function auditList(items: AuditLogEntry[]): string {
  if (items.length === 0) return '<p class="muted">No audit entries.</p>';
  return `<ul class="audit-list">${items
    .map(
      (entry) => `<li>
        <strong>${escapeHtml(entry.action)}</strong>
        <span>${escapeHtml(entry.target_type ?? '—')} ${escapeHtml(entry.target_id ?? '')}</span>
        <small>${escapeHtml(entry.admin_user_id ?? 'system')} · ${formatDate(entry.created_at)}</small>
        <pre>${escapeHtml(formatJson(entry.detail))}</pre>
      </li>`,
    )
    .join('')}</ul>`;
}

function renderAudit(data?: PagedResponse<AuditLogEntry>): void {
  appRoot.innerHTML = shell(`
    <section class="page-header">
      <div>
        <p class="eyebrow">Governance</p>
        <h2>Audit log</h2>
      </div>
      <form id="auditFilter" class="inline-form">
        <input name="action" placeholder="Action" />
        <input name="target_type" placeholder="Target type" />
        <button type="submit">Filter</button>
      </form>
    </section>
    <section class="panel">${auditList(data?.items ?? [])}</section>
  `);
  wireShell();
  document.querySelector<HTMLFormElement>('#auditFilter')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    void runAction(
      async () =>
        listAuditLog({
          action: String(form.get('action') ?? ''),
          target_type: String(form.get('target_type') ?? ''),
        }),
      (audit) => ({ audit }),
    );
  });
}

// Read-only. The per-placement limits are an economy decision (a lucky-spin ad funds a spin rather
// than minting coin), so they are set in region_config, not typed into this form — but an operator
// changing the region-wide cap needs to see which placements override it.
function placementSummary(region: RewardedAdsRegionSettings): string {
  const entries = Object.entries(region.placements ?? {});
  if (entries.length === 0) {
    return '<p class="muted">No per-placement overrides — every ad unit uses the limits above.</p>';
  }
  const rows = entries
    .map(
      ([placement, settings]) =>
        `<li>${escapeHtml(placement)} — ${integer(settings.daily_cap)}/day, ${integer(settings.cooldown_s)}s cooldown, ${String(settings.coin_multiplier)}× coin</li>`,
    )
    .join('');
  return `<div class="muted"><p>Per-placement overrides:</p><ul>${rows}</ul></div>`;
}

function rewardedAdsSection(data?: RewardedAdsSettingsData): string {
  return `<section class="settings-section">
      <div class="settings-section-heading">
        <div><p class="eyebrow">Rewarded ads</p><h3>Daily limit by region</h3></div>
      </div>
      <div class="redemption-settings-grid">
        ${(data?.items ?? [])
          .map(
            (
              region,
            ) => `<form class="panel rewarded-ads-settings-form" data-rewarded-ads-region="${escapeHtml(region.region_id)}">
              <div class="section-heading">
                <div><p class="eyebrow">Region</p><h3>${escapeHtml(region.region_id)}</h3></div>
                <label class="switch-label"><input name="enabled" type="checkbox" ${region.enabled ? 'checked' : ''} /> Rewarded ads enabled</label>
              </div>
              <div class="form-grid">
                <label>
                  Rewarded ads per day
                  <input name="daily_cap" type="number" min="1" max="1000" step="1" value="${region.daily_cap}" required />
                </label>
                <label>
                  Cooldown between ads (seconds)
                  <input name="cooldown_s" type="number" min="0" max="86400" step="1" value="${region.cooldown_s}" required />
                </label>
              </div>
              <p class="muted">Resets at midnight ${escapeHtml(region.timezone)}.</p>
              ${placementSummary(region)}
              <div class="form-actions">
                <button type="submit">Save region</button>
                <span class="muted">Updated ${formatDate(region.updated_at)}</span>
              </div>
            </form>`,
          )
          .join('')}
      </div>
    </section>`;
}

function spinSection(data?: SpinConfigsData): string {
  return `<section class="settings-section">
      <div class="settings-section-heading">
        <div><p class="eyebrow">Lucky spin</p><h3>Paid spins per day</h3></div>
      </div>
      <div class="redemption-settings-grid">
        ${(data?.items ?? [])
          .map((config) => {
            const paidRegions = config.used_by.filter((usage) => usage.role === 'paid');
            const freeRegions = config.used_by.filter((usage) => usage.role === 'free');
            const usageLabel = config.used_by.length
              ? [
                  paidRegions.length
                    ? `paid: ${paidRegions.map((usage) => usage.region_id).join(', ')}`
                    : '',
                  freeRegions.length
                    ? `free: ${freeRegions.map((usage) => usage.region_id).join(', ')}`
                    : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'Not referenced by any region';
            return `<form class="panel spin-config-form" data-spin-config="${escapeHtml(config.id)}">
              <div class="section-heading">
                <div><p class="eyebrow">Spin table</p><h3>${escapeHtml(config.name)}</h3></div>
                <span class="pill">${Number(config.ticket_coin) === 0 ? 'ad-funded' : `${integer(Number(config.ticket_coin))} coin / spin`}</span>
              </div>
              <div class="form-grid">
                <label>
                  Paid spins per day
                  <input name="daily_cap" type="number" min="1" max="1000" step="1" value="${config.daily_cap}" required />
                </label>
              </div>
              <p class="muted">Used by — ${escapeHtml(usageLabel)}. The free spin stays one per day and ignores this cap.</p>
              ${paidRegions.length === 0 ? '<div class="config-warning">No region uses this table for paid spins, so this cap has no effect today.</div>' : ''}
              <div class="form-actions">
                <button type="submit">Save table</button>
                <span class="muted">Updated ${formatDate(config.updated_at)}</span>
              </div>
            </form>`;
          })
          .join('')}
      </div>
    </section>`;
}

// The reward only fires when `enabled` is on AND the payout is above zero — the seeded default is
// off with no payout, which is why a region that has never been through this form pays nothing no
// matter how much of an episode is watched.
function dramaSection(data?: DramaSettingsData): string {
  return `<section class="settings-section">
      <div class="settings-section-heading">
        <div><p class="eyebrow">Drama</p><h3>Episode watch reward by region</h3></div>
      </div>
      <div class="redemption-settings-grid">
        ${(data?.items ?? [])
          .map((region) => {
            const inertPayout = region.enabled && region.episode_reward_coin === 0;
            const inertCap = region.enabled && region.episode_reward_daily_cap === 0;
            return `<form class="panel drama-settings-form" data-drama-region="${escapeHtml(region.region_id)}">
              <div class="section-heading">
                <div><p class="eyebrow">Region</p><h3>${escapeHtml(region.region_id)}</h3></div>
                <label class="switch-label"><input name="enabled" type="checkbox" ${region.enabled ? 'checked' : ''} /> Watch reward enabled</label>
              </div>
              <div class="form-grid">
                <label>
                  Coin per finished episode
                  <input name="episode_reward_coin" type="number" min="0" max="1000000" step="1" value="${region.episode_reward_coin}" required />
                </label>
                <label>
                  Rewarded episodes per day
                  <input name="episode_reward_daily_cap" type="number" min="0" max="10000" step="1" value="${region.episode_reward_daily_cap}" required />
                </label>
                <label>
                  Completion ratio
                  <input name="completion_ratio" type="number" min="0.1" max="1" step="0.05" value="${region.completion_ratio}" required />
                </label>
              </div>
              <p class="muted">Counted from server-verified watch time, not the player's position — a 90s episode at ${region.completion_ratio}× needs ${integer(Math.ceil(90 * region.completion_ratio))}s watched. Resets at midnight ${escapeHtml(region.timezone)}.</p>
              ${inertPayout ? '<div class="config-warning">Enabled but paying 0 coin — the player and its progress tracking stay live, and no episode ever credits.</div>' : ''}
              ${inertCap ? '<div class="config-warning">Enabled but capped at 0 rewarded episodes per day, so no episode ever credits.</div>' : ''}
              <div class="form-actions">
                <button type="submit">Save region</button>
                <span class="muted">Updated ${formatDate(region.updated_at)}</span>
              </div>
            </form>`;
          })
          .join('')}
      </div>
    </section>`;
}

function renderSettings(
  settings?: CoinRewardSettings,
  redemptionSettings?: RedemptionSettingsData,
  rewardedAdsSettings?: RewardedAdsSettingsData,
  spinConfigs?: SpinConfigsData,
  dramaSettings?: DramaSettingsData,
): void {
  const welcomeCoin = settings?.welcome_coin ?? 0;
  const googleLoginCoin = settings?.google_login ?? 0;
  const minRedemptionUsd = redemptionSettings?.min_redemption_usd ?? 5;
  appRoot.innerHTML = shell(`
    <section class="page-header">
      <div>
        <p class="eyebrow">Coin economy</p>
        <h2>Settings</h2>
      </div>
    </section>
    <section class="settings-section">
      <div class="settings-section-heading">
        <div><p class="eyebrow">Acquisition rewards</p><h3>Account bonuses</h3></div>
      </div>
      <form id="coinRewardSettingsForm" class="panel reward-settings-form">
      <div class="form-grid">
        <label>
          Username / password welcome coin
          <input name="welcome_coin" type="number" min="0" max="10000000" step="1" value="${String(settings?.welcome_coin ?? 0)}" required />
        </label>
        <label>
          Google first-login bonus
          <input name="google_login" type="number" min="0" max="10000000" step="1" value="${String(settings?.google_login ?? 0)}" required />
        </label>
      </div>
      <div class="login-offer-preview">
        <div>
          <span>Username / password</span>
          <strong>${integer(welcomeCoin)} coin</strong>
          <small>Welcome reward</small>
        </div>
        <div>
          <span>Google first login</span>
          <strong>${integer(welcomeCoin + googleLoginCoin)} coin</strong>
          <small>${integer(welcomeCoin)} welcome + ${integer(googleLoginCoin)} Google bonus</small>
        </div>
      </div>
      <div class="form-actions">
        <button type="submit">Save settings</button>
        <span class="muted">Updated ${formatDate(settings?.updated_at)}</span>
      </div>
      </form>
    </section>
    <section class="settings-section">
      <div class="settings-section-heading">
        <div><p class="eyebrow">Redemption controls</p><h3>Weekly limits by trust level</h3></div>
        <span class="pill">Minimum payout ${money(minRedemptionUsd)}</span>
      </div>
      <div class="redemption-settings-grid">
        ${(redemptionSettings?.items ?? [])
          .map((region) => {
            const belowMinimum = Object.values(region.weekly_cap_usd).some(
              (cap) => cap < minRedemptionUsd,
            );
            return `<form class="panel redemption-settings-form" data-redemption-region="${escapeHtml(region.region_id)}">
              <div class="section-heading">
                <div><p class="eyebrow">Region</p><h3>${escapeHtml(region.region_id)}</h3></div>
                <label class="switch-label"><input name="enabled" type="checkbox" ${region.enabled ? 'checked' : ''} /> Redemption enabled</label>
              </div>
              <div class="share-grid">
                ${(['0', '1', '2', '3'] as const)
                  .map(
                    (level) => `<label>Trust L${level} cap (USD)
                      <input name="cap_${level}" type="number" min="${minRedemptionUsd}" max="10000" step="0.01" value="${region.weekly_cap_usd[level]}" required />
                    </label>`,
                  )
                  .join('')}
                <label>Claim hold (hours)
                  <input name="claim_hold_hours" type="number" min="0" max="720" step="1" value="${region.claim_hold_hours}" required />
                </label>
              </div>
              <p class="muted">Counted from the moment the user requests the reward. The delivery code stays locked until it elapses; 0 disables the hold.</p>
              ${belowMinimum ? `<div class="config-warning">One or more limits are below the ${money(minRedemptionUsd)} catalog minimum. Update this region before enabling redemptions.</div>` : ''}
              <div class="form-actions">
                <button type="submit">Save region</button>
                <span class="muted">Updated ${formatDate(region.updated_at)}</span>
              </div>
            </form>`;
          })
          .join('')}
      </div>
    </section>
    ${rewardedAdsSection(rewardedAdsSettings)}
    ${spinSection(spinConfigs)}
    ${dramaSection(dramaSettings)}
  `);
  wireShell();
  document
    .querySelector<HTMLFormElement>('#coinRewardSettingsForm')
    ?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget as HTMLFormElement);
      void runAction(
        async () =>
          updateCoinRewardSettings({
            welcome_coin: Number(form.get('welcome_coin')),
            google_login: Number(form.get('google_login')),
          }),
        (coinRewardSettings) => ({ coinRewardSettings }),
      );
    });

  document.querySelectorAll<HTMLFormElement>('[data-redemption-region]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const regionId = form.dataset['redemptionRegion'];
      if (!regionId || !redemptionSettings) return;
      const values = new FormData(form);
      void runAction(
        () =>
          updateRedemptionSettings(regionId, {
            enabled: values.get('enabled') === 'on',
            weekly_cap_usd: {
              '0': Number(values.get('cap_0')),
              '1': Number(values.get('cap_1')),
              '2': Number(values.get('cap_2')),
              '3': Number(values.get('cap_3')),
            },
            claim_hold_hours: Number(values.get('claim_hold_hours')),
          }),
        (updated) => ({
          redemptionSettings: {
            ...redemptionSettings,
            items: redemptionSettings.items.map((region) =>
              region.region_id === updated.region_id ? updated : region,
            ),
          },
        }),
      );
    });
  });

  document.querySelectorAll<HTMLFormElement>('[data-rewarded-ads-region]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const regionId = form.dataset['rewardedAdsRegion'];
      if (!regionId || !rewardedAdsSettings) return;
      const values = new FormData(form);
      void runAction(
        () =>
          updateRewardedAdsSettings(regionId, {
            enabled: values.get('enabled') === 'on',
            daily_cap: Number(values.get('daily_cap')),
            cooldown_s: Number(values.get('cooldown_s')),
          }),
        (updated) => ({
          rewardedAdsSettings: {
            ...rewardedAdsSettings,
            items: rewardedAdsSettings.items.map((region) =>
              region.region_id === updated.region_id ? updated : region,
            ),
          },
        }),
      );
    });
  });

  document.querySelectorAll<HTMLFormElement>('[data-drama-region]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const regionId = form.dataset['dramaRegion'];
      if (!regionId || !dramaSettings) return;
      const values = new FormData(form);
      void runAction(
        () =>
          updateDramaSettings(regionId, {
            enabled: values.get('enabled') === 'on',
            episode_reward_coin: Number(values.get('episode_reward_coin')),
            completion_ratio: Number(values.get('completion_ratio')),
            episode_reward_daily_cap: Number(values.get('episode_reward_daily_cap')),
          }),
        (updated) => ({
          dramaSettings: {
            ...dramaSettings,
            items: dramaSettings.items.map((region) =>
              region.region_id === updated.region_id ? updated : region,
            ),
          },
        }),
      );
    });
  });

  document.querySelectorAll<HTMLFormElement>('[data-spin-config]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const configId = form.dataset['spinConfig'];
      if (!configId || !spinConfigs) return;
      const values = new FormData(form);
      void runAction(
        () => updateSpinConfig(configId, { daily_cap: Number(values.get('daily_cap')) }),
        (updated) => ({
          spinConfigs: {
            ...spinConfigs,
            items: spinConfigs.items.map((config) => (config.id === updated.id ? updated : config)),
          },
        }),
      );
    });
  });
}

async function loadPage(page: Page): Promise<void> {
  setState({ loading: true, error: null });
  try {
    if (page === 'dashboard') {
      const [dashboard, slice] = await Promise.all([getDashboard(), loadDashboardSlice()]);
      setState({ dashboard, ...slice, loading: false });
    }
    if (page === 'offers') setState({ offerwall: await getOfferwallAdminData(), loading: false });
    const network = monitorNetwork(page);
    if (network) {
      state.rewardMonitorHistory = [];
      state.rewardMonitorQuery = rewardMonitorQueryWithoutCursor();
      setState({ rewardMonitor: await rewardMonitorRequest(network), loading: false });
    }
    if (page === 'users') {
      // Entering the page is a fresh start, same as the reward monitor: a stale cursor from a
      // previous visit would open on page 4 of a list the operator has not scrolled yet.
      state.userQuery = { q: '', status: '' };
      state.userHistory = [];
      setState({ users: await usersRequest(), loading: false });
    }
    if (page === 'referrals')
      setState({ referralAdmin: await getReferralAdminData(), loading: false });
    if (page === 'redemptions') {
      // Entering the page resets to the requests tab, so the catalog is only fetched once an
      // operator actually asks for it.
      state.redemptionsTab = 'requests';
      state.redemptionStatus = '';
      state.catalogHistory = [];
      state.catalogQuery = { is_active: '' };
      setState({ redemptions: await listRedemptions({}), loading: false });
    }
    if (page === 'settings') {
      const [
        coinRewardSettings,
        redemptionSettings,
        rewardedAdsSettings,
        spinConfigs,
        dramaSettings,
      ] = await Promise.all([
        getCoinRewardSettings(),
        getRedemptionSettings(),
        getRewardedAdsSettings(),
        getSpinConfigs(),
        getDramaSettings(),
      ]);
      setState({
        coinRewardSettings,
        redemptionSettings,
        rewardedAdsSettings,
        spinConfigs,
        dramaSettings,
        loading: false,
      });
    }
    if (page === 'audit') setState({ audit: await listAuditLog({}), loading: false });
  } catch (error) {
    setState({ error: errorMessage(error), loading: false });
  }
}

function render(): void {
  if (!state.session) {
    renderLogin();
    return;
  }
  if (state.page === 'dashboard') renderDashboard(state.dashboard ?? undefined);
  if (state.page === 'offers') renderOffers(state.offerwall ?? undefined);
  const network = monitorNetwork(state.page);
  if (network) renderRewardMonitor(network, state.rewardMonitor ?? undefined);
  if (state.page === 'users') renderUsers(state.users ?? undefined);
  if (state.page === 'referrals') renderReferrals(state.referralAdmin ?? undefined);
  if (state.page === 'redemptions') renderRedemptions(state.redemptions ?? undefined);
  if (state.page === 'settings')
    renderSettings(
      state.coinRewardSettings ?? undefined,
      state.redemptionSettings ?? undefined,
      state.rewardedAdsSettings ?? undefined,
      state.spinConfigs ?? undefined,
      state.dramaSettings ?? undefined,
    );
  if (state.page === 'audit') renderAudit(state.audit ?? undefined);
}

async function boot(): Promise<void> {
  try {
    const session = await currentSession();
    state.session = session.admin_user;
    await loadPage(state.page);
  } catch {
    state.session = null;
    state.loading = false;
    render();
  }
}

void boot();
