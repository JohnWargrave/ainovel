import type { ColumnType, Generated } from 'kysely';

// Hand-written to mirror 02-DATABASE-SCHEMA.md exactly — no codegen, so schema drift must be
// caught by a human diffing this file against the migrations, not silently regenerated away.

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type Numeric = ColumnType<string, string | number, string | number>;
type Bigint = ColumnType<string, string | number, string | number>;
// Kysely's `Generated<S> = ColumnType<S, S | undefined, S>` only widens the Insert type — nesting
// it over an already-ColumnType alias (Timestamp/Numeric/Bigint) makes Select/Update resolve to the
// wrapper type itself instead of Date/string, breaking every `.where()`/arithmetic `.set()` call
// against these columns. Define the generated variants directly instead of `GeneratedTimestamp`.
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type GeneratedNumeric = ColumnType<string, string | number | undefined, string | number>;
type GeneratedBigint = ColumnType<string, string | number | undefined, string | number>;

export type LedgerEntryType =
  | 'OFFERWALL_CREDIT'
  | 'OFFERWALL_CLAWBACK'
  | 'REWARDED_AD_CREDIT'
  | 'DRAMA_WATCH_CREDIT'
  | 'CHECKIN_CREDIT'
  | 'TASK_CREDIT'
  | 'REFERRAL_CREDIT'
  | 'REFERRAL_CLAWBACK'
  | 'SPIN_TICKET_DEBIT'
  | 'SPIN_PRIZE_CREDIT'
  | 'FREE_SPIN_PRIZE_CREDIT'
  | 'EPISODE_UNLOCK_DEBIT'
  | 'REDEMPTION_DEBIT'
  | 'REDEMPTION_REFUND'
  | 'ADMIN_ADJUSTMENT'
  | 'HOLD_RELEASE'
  | 'WELCOME_CREDIT'
  | 'LOGIN_BIND_CREDIT'
  | 'DIRECT_CREDIT';

export type RedemptionStatus =
  'REQUESTED' | 'FRAUD_REVIEW' | 'APPROVED' | 'PURCHASING' | 'DELIVERED' | 'REJECTED' | 'FAILED';

interface RegionConfigTable {
  region_id: string;
  countries: string[];
  features: unknown;
  updated_at: GeneratedTimestamp;
}

interface CoinRewardSettingsTable {
  id: string;
  welcome_coin: Generated<number>;
  google_login: Generated<number>;
  updated_at: GeneratedTimestamp;
}

interface DirectCoinSettingsTable {
  id: string;
  enabled: Generated<boolean>;
  max_amount_coin: Generated<number>;
  updated_at: GeneratedTimestamp;
}

interface NetworkConfigTable {
  network: string;
  secret_key: string;
  allowed_ips: string[];
  currency_per_usd: Numeric | null;
  hold_hours: Generated<number>;
  high_value_threshold_usd: GeneratedNumeric;
  high_value_hold_hours: Generated<number>;
  credit_immediately: Generated<boolean>;
  is_active: Generated<boolean>;
  shadow_mode: Generated<boolean>;
  signature_format: Generated<string>;
  signature_fields: Generated<string[]>;
  signature_param: Generated<string>;
  reversal_values: Generated<string[]>;
  // Display metadata for GET /offerwall/offers. Nullable until real values exist — see migration 39.
  display_name: string | null;
  icon_url: string | null;
  placement: string | null;
  updated_at: GeneratedTimestamp;
}

interface OfferwallOffersTable {
  id: string;
  code: string;
  provider: string;
  name: string;
  description: Generated<string>;
  icon_url: string | null;
  badge_text: string | null;
  placement: string | null;
  region_ids: Generated<string[]>;
  sort_order: Generated<number>;
  status: Generated<string>;
  starts_at: Timestamp | null;
  ends_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

interface AdminUsersTable {
  id: string;
  email: string;
  role: string;
  password_hash: string | null;
  status: Generated<string>;
  failed_login_count: Generated<number>;
  locked_until: Timestamp | null;
  password_changed_at: Timestamp | null;
  last_login_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

interface AdminSessionsTable {
  id: string;
  admin_user_id: string;
  token_hash: string;
  csrf_hash: string;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  ip: string | null;
  user_agent: string | null;
  last_used_at: GeneratedTimestamp;
  created_at: GeneratedTimestamp;
}

interface UsersTable {
  id: string;
  auth_provider: string;
  auth_subject: string;
  email: string | null;
  country_code: string;
  region_id: string;
  trust_level: Generated<number>;
  status: Generated<string>;
  fraud_score: Generated<number>;
  referral_code: string | null;
  referred_by: string | null;
  referred_by_set_at: Timestamp | null;
  referred_ip: string | null;
  referral_qualified_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

interface DevicesTable {
  id: string;
  user_id: string;
  fingerprint_hash: string;
  installation_id: string | null;
  gaid: string | null;
  model: string | null;
  os_version: string | null;
  app_version: string | null;
  play_integrity_verdict: unknown;
  is_emulator: Generated<boolean>;
  is_rooted: Generated<boolean>;
  first_seen_at: GeneratedTimestamp;
  last_seen_at: GeneratedTimestamp;
}

interface RefreshTokensTable {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  replaced_by: string | null;
  session_id: string;
  auth_provider: string;
  device_id: string | null;
  ip: string | null;
  user_agent: string | null;
  last_used_at: Timestamp;
  session_started_at: Timestamp;
  revocation_reason: string | null;
  created_at: GeneratedTimestamp;
}

interface UserIdentitiesTable {
  id: string;
  user_id: string;
  provider: string;
  provider_subject: string;
  email: string | null;
  email_verified_at: Timestamp | null;
  last_used_at: GeneratedTimestamp;
  disabled_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

interface PasswordCredentialsTable {
  user_id: string;
  username: string;
  email: string;
  password_hash: string;
  email_verified_at: Timestamp | null;
  password_changed_at: GeneratedTimestamp;
  disabled_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

interface AuthEventsTable {
  id: string;
  user_id: string | null;
  provider: string;
  event_type: string;
  outcome: string;
  failure_code: string | null;
  ip: string | null;
  user_agent: string | null;
  device_id: string | null;
  metadata: unknown;
  created_at: GeneratedTimestamp;
}

interface PasswordResetTokensTable {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

interface EmailVerificationTokensTable {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

interface CoinLedgerTable {
  id: string;
  user_id: string;
  entry_type: LedgerEntryType;
  amount: Bigint;
  bucket: Generated<string>;
  ref_type: string | null;
  ref_id: string | null;
  balance_after: Bigint;
  idempotency_key: string | null;
  note: string | null;
  hold_until: Timestamp | null;
  created_at: GeneratedTimestamp;
}

interface WalletsTable {
  user_id: string;
  available_coin: GeneratedBigint;
  pending_coin: GeneratedBigint;
  lifetime_earned: GeneratedBigint;
  lifetime_redeemed: GeneratedBigint;
  lifetime_revenue_usd: GeneratedNumeric;
  updated_at: GeneratedTimestamp;
}

interface EarningEventsTable {
  id: string;
  user_id: string;
  device_id: string | null;
  source: string;
  network_tx_id: string | null;
  payout_usd: Numeric | null;
  coin_awarded: Bigint;
  share_applied: Numeric | null;
  geo_at_event: string | null;
  ip_at_event: string | null;
  status: Generated<string>;
  raw_payload: unknown;
  placement: string | null;
  created_at: GeneratedTimestamp;
}

interface PostbackLogsTable {
  id: string;
  network: string;
  remote_ip: string;
  query_params: unknown;
  verdict: string;
  earning_event_id: string | null;
  created_at: GeneratedTimestamp;
}

interface RewardedAdIntentsTable {
  id: string;
  user_id: string;
  region_id: string;
  status: Generated<string>;
  coin_awarded: Bigint | null;
  earning_event_id: string | null;
  expires_at: Timestamp;
  created_at: GeneratedTimestamp;
  consumed_at: Timestamp | null;
  ip_at_intent: string | null;
  geo_at_intent: string | null;
  placement: string | null;
  spin_history_id: string | null;
}

interface CatalogItemsTable {
  id: string;
  sku: string;
  title: string;
  category: string;
  face_value: string;
  usd_cost: Numeric;
  coin_price: Bigint;
  image_url: string | null;
  seagm_url: string | null;
  regions: string[];
  is_active: Generated<boolean>;
  stock_note: string | null;
  source: Generated<string>;
  updated_at: GeneratedTimestamp;
}

interface CatalogStagingTable {
  id: string;
  sku: string;
  payload: unknown;
  diff: unknown;
  crawl_run_id: string;
  status: Generated<string>;
  created_at: GeneratedTimestamp;
}

interface FxRatesTable {
  currency_pair: string;
  rate: Numeric;
  updated_at: GeneratedTimestamp;
}

interface RedemptionsTable {
  id: string;
  user_id: string;
  catalog_item_id: string;
  coin_price: Bigint;
  usd_cost_est: Numeric;
  status: Generated<RedemptionStatus>;
  fraud_score_at_request: number | null;
  reviewed_by: string | null;
  reviewed_at: Timestamp | null;
  reject_reason: string | null;
  reward_snapshot: unknown;
  delivery_code: string | null;
  delivery_note: string | null;
  delivered_at: Timestamp | null;
  claimed_at: Timestamp | null;
  claimable_at: GeneratedTimestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

interface RedemptionStatusHistoryTable {
  id: string;
  redemption_id: string;
  from_status: RedemptionStatus | null;
  to_status: RedemptionStatus;
  actor: string;
  note: string | null;
  created_at: GeneratedTimestamp;
}

interface DramaSeriesTable {
  id: string;
  title: string;
  description: string | null;
  cover_url: string | null;
  license_regions: string[];
  license_expires: string | null;
  total_episodes: number;
  interstitial_every: Generated<number>;
  status: Generated<string>;
  created_at: GeneratedTimestamp;
}

interface DramaEpisodesTable {
  id: string;
  series_id: string;
  episode_no: number;
  byteplus_vid: string;
  duration_s: number;
}

interface DramaAdImpressionsTable {
  id: string;
  user_id: string;
  intent_id: string;
  episode_id: string | null;
  ad_network: string | null;
  revenue_source: string;
  est_revenue_usd: Numeric;
  coin_awarded: Bigint;
  geo: string | null;
  reconciled: Generated<boolean>;
  created_at: GeneratedTimestamp;
}

interface WatchSessionsTable {
  id: string;
  user_id: string;
  episode_id: string;
  watch_time_s: Generated<number>;
  geo: string | null;
  ip: string | null;
  rewarded: Generated<boolean>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

// Server-verified progress for POST /drama/watch-heartbeat. drama_id is the app's own catalog id
// with no FK — see migration 1700000000064.
interface DramaWatchProgressTable {
  id: string;
  user_id: string;
  drama_id: string;
  episode_index: number;
  duration_s: number;
  watch_time_s: Generated<number>;
  last_position_s: Generated<number>;
  last_heartbeat_at: GeneratedTimestamp;
  rewarded_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

interface SpinConfigTable {
  id: string;
  name: string;
  ticket_coin: GeneratedBigint;
  max_ev_coin: GeneratedBigint;
  daily_cap: Generated<number>;
  pity_threshold: Generated<number>;
  prizes: unknown;
  is_active: Generated<boolean>;
  free_table_id: string | null;
  updated_at: GeneratedTimestamp;
}

interface SpinHistoryTable {
  id: string;
  user_id: string;
  spin_config_id: string;
  server_seed_hash: string;
  server_seed: Generated<string | null>;
  roll: Numeric;
  prize_slot: number;
  prize_type: string;
  prize_value: string;
  pity_applied: Generated<boolean>;
  mode: Generated<string>;
  created_at: GeneratedTimestamp;
}

interface FraudFlagsTable {
  id: string;
  user_id: string;
  rule_code: string;
  severity: number;
  evidence: unknown;
  status: Generated<string>;
  created_at: GeneratedTimestamp;
}

interface AuditLogTable {
  id: string;
  admin_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: unknown;
  ip: string | null;
  created_at: GeneratedTimestamp;
}

interface InboxMessagesTable {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  payload: unknown;
  read_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

export interface DB {
  region_config: RegionConfigTable;
  coin_reward_settings: CoinRewardSettingsTable;
  direct_coin_settings: DirectCoinSettingsTable;
  network_config: NetworkConfigTable;
  offerwall_offers: OfferwallOffersTable;
  admin_users: AdminUsersTable;
  admin_sessions: AdminSessionsTable;
  users: UsersTable;
  devices: DevicesTable;
  user_identities: UserIdentitiesTable;
  password_credentials: PasswordCredentialsTable;
  auth_events: AuthEventsTable;
  password_reset_tokens: PasswordResetTokensTable;
  email_verification_tokens: EmailVerificationTokensTable;
  refresh_tokens: RefreshTokensTable;
  coin_ledger: CoinLedgerTable;
  wallets: WalletsTable;
  earning_events: EarningEventsTable;
  postback_logs: PostbackLogsTable;
  rewarded_ad_intents: RewardedAdIntentsTable;
  catalog_items: CatalogItemsTable;
  catalog_staging: CatalogStagingTable;
  fx_rates: FxRatesTable;
  redemptions: RedemptionsTable;
  redemption_status_history: RedemptionStatusHistoryTable;
  drama_series: DramaSeriesTable;
  drama_episodes: DramaEpisodesTable;
  drama_ad_impressions: DramaAdImpressionsTable;
  watch_sessions: WatchSessionsTable;
  drama_watch_progress: DramaWatchProgressTable;
  spin_config: SpinConfigTable;
  spin_history: SpinHistoryTable;
  fraud_flags: FraudFlagsTable;
  audit_log: AuditLogTable;
  inbox_messages: InboxMessagesTable;
}
