export interface AdminUser {
  id: string;
  email: string;
  role: string;
}

export interface CmsSession {
  admin_user: AdminUser;
  csrf_token: string;
}

export interface PagedResponse<T> {
  items: T[];
  next_cursor: string | null;
}

export interface WalletSummary {
  available_coin: string;
  pending_coin: string;
  lifetime_earned: string;
  lifetime_redeemed: string;
}

export interface AdminUserSummary {
  id: string;
  auth_provider: string;
  email: string | null;
  country_code: string;
  region_id: string;
  status: string;
  trust_level: number;
  fraud_score: number;
  created_at: string;
  wallet: WalletSummary;
  open_flag_count: number;
}

export interface AdminUserDetail extends AdminUserSummary {
  referral_code: string | null;
  password_credential: null | {
    username: string;
    email: string;
    email_verified_at: string | null;
    password_changed_at: string;
    disabled_at: string | null;
    created_at: string;
  };
  identities: Array<{
    provider: string;
    email: string | null;
    email_verified_at: string | null;
    last_used_at: string;
    disabled_at: string | null;
    created_at: string;
  }>;
  welcome_credit: { granted: boolean; amount: string | null; granted_at: string | null };
  active_sessions: Array<{
    id: string;
    provider: string;
    device_id: string | null;
    ip: string | null;
    user_agent: string | null;
    created_at: string;
    last_used_at: string;
    expires_at: string;
  }>;
  auth_events: Array<{
    id: string;
    provider: string;
    event_type: string;
    outcome: string;
    failure_code: string | null;
    ip: string | null;
    device_id: string | null;
    metadata: unknown;
    created_at: string;
  }>;
  ledger: Array<{
    id: string;
    entry_type: string;
    amount: string;
    bucket: string;
    balance_after: string;
    note: string | null;
    created_at: string;
  }>;
  admin_audit: Array<{
    id: string;
    admin_user_id: string | null;
    action: string;
    detail: unknown;
    created_at: string;
  }>;
}

export interface CoinAdjustmentResponse {
  ledger_id: string;
  amount_coin: number;
  previous_balance: string;
  new_balance: string;
  deduped: boolean;
}

export interface EconomyAnalytics {
  from: string;
  to: string;
  region: string | null;
  coin_minted_by_source: Record<string, string>;
  coin_burned_by_sink: Record<string, string>;
  coin_minted_total: string;
  coin_burned_total: string;
  unbacked_coin: string;
  unbacked_pct: number;
  coin_redeemed_usd_cost: number;
  revenue_usd: number;
  clawback_rate_by_network: Record<string, number>;
  backing_ratio_today: number | null;
  mint_paused: boolean;
}

export interface AuditLogEntry {
  id: string;
  admin_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: unknown;
  ip: string | null;
  created_at: string;
}

export type WelcomeMode = 'instant' | 'link_required';

export interface CoinRewardSettings {
  welcome_coin: number;
  google_login: number;
  welcome_mode: WelcomeMode;
  updated_at: string;
}

export interface RedemptionRegionSettings {
  region_id: string;
  enabled: boolean;
  weekly_cap_usd: { '0': number; '1': number; '2': number; '3': number };
  claim_hold_hours: number;
  updated_at: string;
}

export interface RedemptionSettingsData {
  min_redemption_usd: number;
  items: RedemptionRegionSettings[];
}
export interface RewardedAdPlacementSettings {
  daily_cap: number;
  cooldown_s: number;
  coin_multiplier: number;
}
export interface RewardedAdsRegionSettings {
  region_id: string;
  enabled: boolean;
  daily_cap: number;
  cooldown_s: number;
  // Per ad unit (checkin / earncoin / luckyspin / chapter_unlock). A placement missing here inherits
  // the region-wide daily_cap and cooldown_s above. Read-only in this form — the PUT carries it
  // through untouched. chapter_unlock opens a VIP novel chapter instead of paying coin.
  placements: Partial<
    Record<'checkin' | 'earncoin' | 'luckyspin' | 'chapter_unlock', RewardedAdPlacementSettings>
  >;
  timezone: string;
  updated_at: string;
}
export interface RewardedAdsSettingsData {
  items: RewardedAdsRegionSettings[];
}
export interface SpinConfigAdmin {
  id: string;
  name: string;
  // "0" on every active table — spins are funded by a rewarded ad, not by the wallet.
  ticket_coin: string;
  max_ev_coin: string;
  daily_cap: number;
  is_active: boolean;
  used_by: Array<{ region_id: string; role: 'paid' | 'free' }>;
  updated_at: string;
}
export interface SpinConfigsData {
  items: SpinConfigAdmin[];
}

export interface ReferralSettings {
  region_id: string;
  enabled: boolean;
  reward_pct: number;
  duration_months: number | null;
  milestone_bonus_coin: number;
  milestone_bonus_threshold: number;
  hold_hours: number;
  credit_immediately: boolean;
  updated_at: string;
}

export interface ReferralSummary {
  user_id: string;
  email: string | null;
  referral_code: string | null;
  region_id: string;
  status: string;
  total_referrals: number;
  qualified_referrals: number;
  pending_referrals: number;
  total_earned_coin: string;
  available_earned_coin: string;
  pending_earned_coin: string;
  clawed_back_coin: string;
  referral_frozen: boolean;
  referral_blocked: boolean;
}

export interface ReferralUser {
  id: string;
  email: string | null;
  referral_code: string | null;
  region_id: string;
  status: string;
  referral_qualified_at: string | null;
  referred_by_set_at: string | null;
  created_at: string;
}

export interface ReferralDetail {
  summary: ReferralSummary;
  user: ReferralUser;
  referrer: ReferralUser | null;
  referred_users: ReferralUser[];
  recent_earnings: Array<{
    id: string;
    entry_type: string;
    amount: string;
    bucket: string;
    state: 'available' | 'pending' | 'frozen' | 'clawed_back';
    hold_until: string | null;
    source_event_id: string | null;
    created_at: string;
  }>;
}

export interface ReferralAdminData {
  settings: ReferralSettings[];
  referrals: PagedResponse<ReferralSummary>;
}

export interface DashboardResponse {
  counts: {
    users_total: number;
    redemptions_pending: number;
    fraud_flags_open: number;
    catalog_items_active: number;
  };
  economy: EconomyAnalytics;
  regions: string[];
  recent_audit_log: AuditLogEntry[];
}

// The rewards a user can exchange coin for. `usd_cost` and `seagm_url` are admin-only — the public
// /catalog deliberately omits them because they expose supplier margin.
export interface CatalogItemAdmin {
  id: string;
  sku: string;
  title: string;
  category: string;
  face_value: string;
  usd_cost: string;
  coin_price: string;
  image_url: string | null;
  seagm_url: string | null;
  regions: string[];
  is_active: boolean;
  stock_note: string | null;
  // 'crawler' or 'manual' — provenance, so an operator knows what the next crawl may overwrite.
  source: string;
  updated_at: string;
}

export interface CreateCatalogItemInput {
  sku: string;
  title: string;
  category: string;
  face_value: string;
  usd_cost: number;
  coin_price: number;
  image_url?: string;
  seagm_url?: string;
  regions: string[];
  is_active?: boolean;
  stock_note?: string;
}

// sku and category are create-only on the server, so the edit form must not offer them.
export type UpdateCatalogItemInput = Partial<Omit<CreateCatalogItemInput, 'sku' | 'category'>>;

export interface AnalyticsTimeseriesPoint {
  date: string;
  coin_minted: string;
  coin_burned: string;
  new_users: number;
  revenue_usd: number;
}

export interface AnalyticsTimeseriesResponse {
  from: string;
  to: string;
  region: string | null;
  // Dense — one entry per day in the range, zero-filled.
  points: AnalyticsTimeseriesPoint[];
}

export type RewardMonitorNetwork = 'tapjoy' | 'pubscale';

export interface RewardMonitorResponse {
  network: RewardMonitorNetwork;
  from: string;
  to: string;
  summary: {
    callbacks_received: number;
    callbacks_not_credited: number;
    rewards_credited: number;
    coins_credited: string;
    unique_users: number;
    latest_credit_at: string | null;
  };
  rewards: Array<{
    id: string;
    created_at: string;
    user_id: string;
    transaction_id: string | null;
    payout_usd: string | null;
    coins_awarded: string;
    share_applied: string | null;
    status: string;
    bucket: string;
    available_balance_after: string;
    hold_until: string | null;
  }>;
  next_cursor: string | null;
  recent_callbacks: Array<{
    id: string;
    created_at: string;
    verdict: string;
    user_id: string | null;
    transaction_id: string | null;
    earning_event_id: string | null;
  }>;
}

export type OfferwallOfferStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface OfferwallOffer {
  id: string;
  code: string;
  provider: string;
  name: string;
  description: string;
  icon_url: string | null;
  badge_text: string | null;
  placement: string | null;
  region_ids: string[];
  sort_order: number;
  status: OfferwallOfferStatus;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OfferwallProvider {
  provider: string;
  display_name: string | null;
  icon_url: string | null;
  placement: string | null;
  placement_source: 'environment' | 'database';
  allowed_ips: string[];
  currency_per_usd: string | null;
  hold_hours: number;
  high_value_threshold_usd: string;
  high_value_hold_hours: number;
  credit_immediately: boolean;
  is_active: boolean;
  shadow_mode: boolean;
  secret_configured: boolean;
  callback_url: string;
  updated_at: string;
}

export interface OfferwallRegionSettings {
  region_id: string;
  enabled: boolean;
  networks: string[];
  shares: { '0': number; '1': number; '2': number; '3': number };
  updated_at: string;
}

export interface OfferwallAdminData {
  offers: OfferwallOffer[];
  providers: OfferwallProvider[];
  settings: OfferwallRegionSettings[];
}

export interface OfferwallOfferInput {
  code: string;
  provider: string;
  name: string;
  description?: string;
  icon_url?: string | null;
  badge_text?: string | null;
  placement?: string | null;
  region_ids: string[];
  sort_order?: number;
  status?: OfferwallOfferStatus;
  starts_at?: string | null;
  ends_at?: string | null;
}

export interface Redemption {
  id: string;
  status: string;
  catalog_item_id: string;
  reward: {
    sku: string;
    title: string;
    category: string;
    face_value: string;
    image_url: string | null;
  };
  coin_price: string;
  usd_cost_est: string;
  fraud_score_at_request: number | null;
  reject_reason: string | null;
  delivery_note: string | null;
  delivered_at: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminRedemptionSummary extends Redemption {
  user: {
    id: string;
    email: string | null;
    status: string;
    region_id: string;
    country_code: string;
  };
  catalog_item: {
    id: string;
    sku: string;
    title: string;
    category: string;
    face_value: string;
    seagm_url: string | null;
    stock_note: string | null;
  };
}

export interface RedemptionDetail {
  redemption: Redemption;
  user: {
    id: string;
    email: string | null;
    status: string;
    trust_level: number;
    fraud_score: number;
    region_id: string;
    country_code: string;
  };
  catalog_item: {
    id: string;
    sku: string;
    title: string;
    category: string;
    face_value: string;
    image_url: string | null;
    seagm_url: string | null;
    usd_cost: string;
    coin_price: string;
    is_active: boolean;
    stock_note: string | null;
  };
  history: Array<{
    id: string;
    from_status: string | null;
    to_status: string;
    actor: string;
    note: string | null;
    created_at: string;
  }>;
}

interface ErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let csrfToken = '';

export function setCsrfToken(nextToken: string): void {
  csrfToken = nextToken;
}

export function getCsrfToken(): string {
  return csrfToken;
}

export function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const value = search.toString();
  return value ? `?${value}` : '';
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  // FormData bodies (file uploads) need the browser to set the multipart boundary itself.
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  if (csrfToken && options.method && options.method !== 'GET')
    headers.set('x-csrf-token', csrfToken);

  const response = await fetch(path, { ...options, headers, credentials: 'include' });
  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? ((await response.json()) as unknown)
    : null;
  if (!response.ok) {
    const error = payload as ErrorResponse | null;
    throw new ApiError(
      response.status,
      error?.error?.code ?? 'REQUEST_FAILED',
      error?.error?.message ?? `Request failed with status ${response.status}`,
    );
  }
  return payload as T;
}

export async function login(email: string, password: string): Promise<CmsSession> {
  const session = await api<CmsSession>('/admin/session', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setCsrfToken(session.csrf_token);
  return session;
}

export async function currentSession(): Promise<CmsSession> {
  const session = await api<CmsSession>('/admin/session');
  setCsrfToken(session.csrf_token);
  return session;
}

export async function logout(): Promise<void> {
  await api<void>('/admin/session', { method: 'DELETE' });
  setCsrfToken('');
}

export function listCatalogItems(params: {
  is_active?: string;
  cursor?: string;
}): Promise<PagedResponse<CatalogItemAdmin>> {
  return api<PagedResponse<CatalogItemAdmin>>(
    `/admin/catalog${queryString({ ...params, limit: 50 })}`,
  );
}

export function createCatalogItem(input: CreateCatalogItemInput): Promise<CatalogItemAdmin> {
  return api<CatalogItemAdmin>('/admin/catalog', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// POST, not PATCH — the server mounts the update on POST /admin/catalog/:id.
export function updateCatalogItem(
  id: string,
  input: UpdateCatalogItemInput,
): Promise<CatalogItemAdmin> {
  return api<CatalogItemAdmin>(`/admin/catalog/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getDashboard(): Promise<DashboardResponse> {
  return api<DashboardResponse>('/admin/dashboard');
}

export function getEconomyAnalytics(params: {
  from?: string;
  region?: string;
}): Promise<EconomyAnalytics> {
  return api<EconomyAnalytics>(`/admin/analytics/economy${queryString({ ...params })}`);
}

export function getAnalyticsTimeseries(params: {
  days?: number;
  region?: string;
}): Promise<AnalyticsTimeseriesResponse> {
  return api<AnalyticsTimeseriesResponse>(
    `/admin/analytics/timeseries${queryString({ ...params })}`,
  );
}

export function getRewardMonitor(
  network: RewardMonitorNetwork,
  params: {
    window_hours?: number;
    user_id?: string;
    transaction_id?: string;
    cursor?: string;
  },
): Promise<RewardMonitorResponse> {
  return api<RewardMonitorResponse>(
    `/admin/reward-monitors/${network}${queryString({ ...params, limit: 50 })}`,
  );
}

export function getCoinRewardSettings(): Promise<CoinRewardSettings> {
  return api<CoinRewardSettings>('/admin/coin-reward-settings');
}

export function updateCoinRewardSettings(input: {
  welcome_coin: number;
  google_login: number;
  welcome_mode: WelcomeMode;
}): Promise<CoinRewardSettings> {
  return api<CoinRewardSettings>('/admin/coin-reward-settings', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function getRedemptionSettings(): Promise<RedemptionSettingsData> {
  return api<RedemptionSettingsData>('/admin/redemption/settings');
}

export function updateRedemptionSettings(
  regionId: string,
  input: {
    enabled: boolean;
    weekly_cap_usd: { '0': number; '1': number; '2': number; '3': number };
    claim_hold_hours: number;
  },
): Promise<RedemptionRegionSettings> {
  return api<RedemptionRegionSettings>(
    `/admin/redemption/settings/${encodeURIComponent(regionId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(input),
    },
  );
}

export function getRewardedAdsSettings(): Promise<RewardedAdsSettingsData> {
  return api<RewardedAdsSettingsData>('/admin/rewarded-ads/settings');
}

export function updateRewardedAdsSettings(
  regionId: string,
  input: { enabled: boolean; daily_cap: number; cooldown_s: number },
): Promise<RewardedAdsRegionSettings> {
  return api<RewardedAdsRegionSettings>(
    `/admin/rewarded-ads/settings/${encodeURIComponent(regionId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(input),
    },
  );
}

export function getSpinConfigs(): Promise<SpinConfigsData> {
  return api<SpinConfigsData>('/admin/spin/configs');
}

export function updateSpinConfig(
  configId: string,
  input: { daily_cap: number },
): Promise<SpinConfigAdmin> {
  return api<SpinConfigAdmin>(`/admin/spin/configs/${encodeURIComponent(configId)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function getReferralAdminData(): Promise<ReferralAdminData> {
  const [settings, referrals] = await Promise.all([
    api<{ items: ReferralSettings[] }>('/admin/referrals/settings'),
    listReferrals({}),
  ]);
  return { settings: settings.items, referrals };
}

export function listReferrals(params: {
  q?: string;
  region_id?: string;
  cursor?: string;
}): Promise<PagedResponse<ReferralSummary>> {
  return api<PagedResponse<ReferralSummary>>(
    `/admin/referrals${queryString({ ...params, limit: 50 })}`,
  );
}

export function getReferralDetail(userId: string): Promise<ReferralDetail> {
  return api<ReferralDetail>(`/admin/referrals/${encodeURIComponent(userId)}`);
}

export function updateReferralSettings(
  regionId: string,
  input: {
    enabled: boolean;
    reward_pct: number;
    duration_months: number | null;
    milestone_bonus_coin: number;
    milestone_bonus_threshold: number;
    hold_hours: number;
    credit_immediately: boolean;
  },
): Promise<ReferralSettings> {
  return api<ReferralSettings>(`/admin/referrals/settings/${encodeURIComponent(regionId)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function updateReferralCode(
  userId: string,
  code: string,
  reason: string,
): Promise<ReferralDetail> {
  return api<ReferralDetail>(`/admin/referrals/${encodeURIComponent(userId)}/code`, {
    method: 'PUT',
    body: JSON.stringify({ code, reason }),
  });
}

export function regenerateReferralCode(userId: string, reason: string): Promise<ReferralDetail> {
  return api<ReferralDetail>(`/admin/referrals/${encodeURIComponent(userId)}/code/regenerate`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function clearReferralFreeze(userId: string, reason: string): Promise<ReferralDetail> {
  return api<ReferralDetail>(`/admin/referrals/${encodeURIComponent(userId)}/clear-freeze`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function getOfferwallAdminData(): Promise<OfferwallAdminData> {
  const [offers, providers, settings] = await Promise.all([
    api<{ items: OfferwallOffer[] }>('/admin/offerwall/offers'),
    api<{ items: OfferwallProvider[] }>('/admin/offerwall/providers'),
    api<{ items: OfferwallRegionSettings[] }>('/admin/offerwall/settings'),
  ]);
  return { offers: offers.items, providers: providers.items, settings: settings.items };
}

export function createOfferwallOffer(input: OfferwallOfferInput): Promise<OfferwallOffer> {
  return api<OfferwallOffer>('/admin/offerwall/offers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateOfferwallOffer(
  id: string,
  input: Partial<OfferwallOfferInput>,
): Promise<OfferwallOffer> {
  return api<OfferwallOffer>(`/admin/offerwall/offers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function archiveOfferwallOffer(id: string): Promise<OfferwallOffer> {
  return api<OfferwallOffer>(`/admin/offerwall/offers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function updateOfferwallProvider(
  provider: string,
  input: {
    display_name: string | null;
    icon_url: string | null;
    placement?: string | null;
    allowed_ips: string[];
    currency_per_usd: number | null;
    hold_hours: number;
    high_value_threshold_usd: number;
    high_value_hold_hours: number;
    credit_immediately: boolean;
    is_active: boolean;
    shadow_mode: boolean;
  },
): Promise<OfferwallProvider> {
  return api<OfferwallProvider>(`/admin/offerwall/providers/${encodeURIComponent(provider)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function updateOfferwallRegionSettings(
  regionId: string,
  input: {
    enabled: boolean;
    networks: string[];
    shares: { '0': number; '1': number; '2': number; '3': number };
  },
): Promise<OfferwallRegionSettings> {
  return api<OfferwallRegionSettings>(`/admin/offerwall/settings/${encodeURIComponent(regionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listUsers(params: {
  q?: string;
  status?: string;
  region_id?: string;
  cursor?: string;
}): Promise<PagedResponse<AdminUserSummary>> {
  return api<PagedResponse<AdminUserSummary>>(
    `/admin/users${queryString({ ...params, limit: 50 })}`,
  );
}

export function getUser(id: string): Promise<AdminUserDetail> {
  return api<AdminUserDetail>(`/admin/users/${encodeURIComponent(id)}`);
}

export function adjustUserCoin(
  id: string,
  amountCoin: number,
  reason: string,
  idempotencyKey: string,
): Promise<CoinAdjustmentResponse> {
  return api<CoinAdjustmentResponse>(`/admin/users/${encodeURIComponent(id)}/coin-adjustment`, {
    method: 'POST',
    body: JSON.stringify({
      amount_coin: amountCoin,
      reason,
      idempotency_key: idempotencyKey,
    }),
  });
}

export function grantUserCoin(
  id: string,
  amountCoin: number,
  reason: string,
  idempotencyKey: string,
): Promise<CoinAdjustmentResponse> {
  return adjustUserCoin(id, amountCoin, reason, idempotencyKey);
}

export function revokeUserSession(
  userId: string,
  sessionId: string,
  reason: string,
): Promise<AdminUserDetail> {
  return api<AdminUserDetail>(
    `/admin/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', body: JSON.stringify({ reason }) },
  );
}

export function revokeAllUserSessions(userId: string, reason: string): Promise<AdminUserDetail> {
  return api<AdminUserDetail>(`/admin/users/${encodeURIComponent(userId)}/sessions/revoke-all`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function disableUserCredential(
  userId: string,
  provider: 'guest' | 'google' | 'facebook' | 'password',
  reason: string,
): Promise<AdminUserDetail> {
  return api<AdminUserDetail>(
    `/admin/users/${encodeURIComponent(userId)}/credentials/${provider}/disable`,
    { method: 'POST', body: JSON.stringify({ reason }) },
  );
}

export function listRedemptions(params: {
  status?: string;
  cursor?: string;
}): Promise<PagedResponse<AdminRedemptionSummary>> {
  return api<PagedResponse<AdminRedemptionSummary>>(
    `/admin/redemptions${queryString({ ...params, limit: 50 })}`,
  );
}

export function getRedemption(id: string): Promise<RedemptionDetail> {
  return api<RedemptionDetail>(`/admin/redemptions/${encodeURIComponent(id)}`);
}

export function approveRedemption(id: string, note?: string): Promise<Redemption> {
  return api<Redemption>(`/admin/redemptions/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

export function rejectRedemption(id: string, reason: string): Promise<Redemption> {
  return api<Redemption>(`/admin/redemptions/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function fulfillRedemption(id: string, note?: string): Promise<Redemption> {
  return api<Redemption>(`/admin/redemptions/${encodeURIComponent(id)}/fulfill`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

export function pasteRedemptionCode(
  id: string,
  deliveryCode: string,
  note?: string,
): Promise<Redemption> {
  return api<Redemption>(`/admin/redemptions/${encodeURIComponent(id)}/paste-code`, {
    method: 'POST',
    body: JSON.stringify({ delivery_code: deliveryCode, note }),
  });
}

export function listAuditLog(params: {
  actor_id?: string;
  action?: string;
  target_type?: string;
  target_id?: string;
  cursor?: string;
}): Promise<PagedResponse<AuditLogEntry>> {
  return api<PagedResponse<AuditLogEntry>>(
    `/admin/audit-log${queryString({ ...params, limit: 50 })}`,
  );
}
