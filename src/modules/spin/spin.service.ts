import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import type { Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { dayWindow } from '../../lib/day-window.js';
import { creditInTransaction } from '../wallet-ledger/ledger.service.js';
import { buildState } from '../rewarded-ads/intent.service.js';
import { getRewardedAdsFeature } from '../rewarded-ads/region-feature.js';
import { getSpinFeature, type SpinFeature } from './region-feature.js';
import type { SpinResponse, SpinStateResponse } from './schemas.js';

const RED_FRAUD_THRESHOLD = 70;
const ROLL_DENOMINATOR = 2 ** 48;
const VALID_PRIZE_TYPES = ['coin', 'voucher', 'boost'] as const;
const VALID_TIERS = ['low', 'mid', 'high', 'jackpot'] as const;

type PrizeType = (typeof VALID_PRIZE_TYPES)[number];
type PrizeTier = (typeof VALID_TIERS)[number];
type SpinMode = 'paid' | 'free';

interface SpinPrize {
  slot: number;
  type: PrizeType;
  value: number | string;
  weight: number;
  tier: PrizeTier;
  label: string;
}

interface SpinConfig {
  id: string;
  ticketCoin: number;
  maxEvCoin: number;
  dailyCap: number;
  pityThreshold: number;
  prizes: SpinPrize[];
  freeTableId: string | null;
}

interface UserForSpin {
  id: string;
  regionId: string;
  status: string;
  fraudScore: number;
}

interface RollResult {
  seed: string;
  seedHash: string;
  rollString: string;
  rollFraction: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertInteger(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AppError(code, 'Spin config is malformed', 500);
  }
  return value;
}

function assertPrizeType(value: unknown): PrizeType {
  if (typeof value === 'string' && VALID_PRIZE_TYPES.includes(value as PrizeType)) {
    return value as PrizeType;
  }
  throw new AppError('SPIN_CONFIG_MALFORMED', 'Spin config is malformed', 500);
}

function assertTier(value: unknown): PrizeTier {
  if (typeof value === 'string' && VALID_TIERS.includes(value as PrizeTier)) {
    return value as PrizeTier;
  }
  throw new AppError('SPIN_CONFIG_MALFORMED', 'Spin config is malformed', 500);
}

function expectedValue(prizes: SpinPrize[]): number {
  const totalWeight = prizes.reduce((sum, prize) => sum + prize.weight, 0);
  return prizes.reduce((sum, prize) => {
    const coinValue = prize.type === 'coin' && typeof prize.value === 'number' ? prize.value : 0;
    return sum + (coinValue * prize.weight) / totalWeight;
  }, 0);
}

function validatePrizeTable(raw: unknown, maxEvCoin: number, mode: SpinMode): SpinPrize[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError('SPIN_CONFIG_MALFORMED', 'Spin config is malformed', 500);
  }
  const slots = new Set<number>();
  const prizes = raw.map((entry) => {
    if (!isRecord(entry)) {
      throw new AppError('SPIN_CONFIG_MALFORMED', 'Spin config is malformed', 500);
    }
    const slot = assertInteger(entry['slot'], 'SPIN_CONFIG_MALFORMED');
    const weight = assertInteger(entry['weight'], 'SPIN_CONFIG_MALFORMED');
    const type = assertPrizeType(entry['type']);
    const tier = assertTier(entry['tier']);
    const value = entry['value'];
    if (slot <= 0 || weight <= 0 || slots.has(slot)) {
      throw new AppError('SPIN_CONFIG_MALFORMED', 'Spin config is malformed', 500);
    }
    slots.add(slot);
    if (mode === 'free' && tier === 'jackpot') {
      throw new AppError('SPIN_CONFIG_MALFORMED', 'Spin config is malformed', 500);
    }
    if (type === 'coin') {
      const coinValue = assertInteger(value, 'SPIN_CONFIG_MALFORMED');
      if (coinValue < 0) {
        throw new AppError('SPIN_CONFIG_MALFORMED', 'Spin config is malformed', 500);
      }
      return {
        slot,
        type,
        tier,
        value: coinValue,
        weight,
        label: typeof entry['label'] === 'string' ? entry['label'] : `${String(coinValue)} coin`,
      };
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new AppError('SPIN_CONFIG_MALFORMED', 'Spin config is malformed', 500);
    }
    return {
      slot,
      type,
      tier,
      value,
      weight,
      label: typeof entry['label'] === 'string' ? entry['label'] : value,
    };
  });
  const ev = expectedValue(prizes);
  // Bounded by an explicit column rather than by ticket_coin: the paid table is ad-funded now, its
  // ticket is 0, and `ev >= 0 * 0.95` would reject every non-empty prize table.
  if (mode === 'paid' && ev > maxEvCoin) {
    throw new AppError('SPIN_CONFIG_EV_INVALID', 'Spin config EV is invalid', 500);
  }
  if (mode === 'free' && (ev < 30 || ev > 50)) {
    throw new AppError('SPIN_CONFIG_EV_INVALID', 'Spin config EV is invalid', 500);
  }
  return prizes;
}

function prizeDisplay(prizes: SpinPrize[]): SpinStateResponse['prizes_display'] {
  const totalWeight = prizes.reduce((sum, prize) => sum + prize.weight, 0);
  return prizes.map((prize) => ({
    slot: prize.slot,
    type: prize.type,
    value: String(prize.value),
    tier: prize.tier,
    label: prize.label,
    pct: Math.round((prize.weight / totalWeight) * 1000) / 10,
  }));
}

function roll(): RollResult {
  const seedBuffer = randomBytes(32);
  const seed = seedBuffer.toString('hex');
  const digest = createHash('sha256').update(seedBuffer).digest();
  const seedHash = digest.toString('hex');
  // Six digest bytes fit safely in JavaScript's integer range. Dividing by 2^48 produces the exact
  // recorded roll from the stored seed while preserving a uniform distribution over [0, 1).
  const n = digest.readUIntBE(0, 6);
  return {
    seed,
    seedHash,
    rollString: (n / ROLL_DENOMINATOR).toFixed(8),
    rollFraction: n / ROLL_DENOMINATOR,
  };
}

function selectPrize(prizes: SpinPrize[], rollFraction: number): SpinPrize {
  const totalWeight = prizes.reduce((sum, prize) => sum + prize.weight, 0);
  const target = rollFraction * totalWeight;
  let cumulative = 0;
  for (const prize of prizes) {
    cumulative += prize.weight;
    if (target < cumulative) return prize;
  }
  const fallback = prizes[prizes.length - 1];
  if (!fallback) {
    throw new AppError('SPIN_CONFIG_MALFORMED', 'Spin config is malformed', 500);
  }
  return fallback;
}

function applyPity(prizes: SpinPrize[], eligible: boolean): SpinPrize[] {
  if (!eligible) return prizes;
  return prizes.map((prize) =>
    prize.tier === 'high' ? { ...prize, weight: prize.weight * 3 } : prize,
  );
}

async function loadUserForSpin(userId: string, trx: Transaction<DB>): Promise<UserForSpin> {
  const user = await trx
    .selectFrom('users')
    .select(['id', 'region_id', 'status', 'fraud_score'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) {
    throw new AppError('USER_NOT_FOUND', 'User not found', 404);
  }
  if (user.status !== 'active' || user.fraud_score >= RED_FRAUD_THRESHOLD) {
    throw new AppError('SPIN_SUSPENDED', 'Spin is unavailable', 403);
  }
  return {
    id: user.id,
    regionId: user.region_id,
    status: user.status,
    fraudScore: user.fraud_score,
  };
}

async function loadConfig(
  trx: Transaction<DB>,
  tableId: string,
  mode: SpinMode,
): Promise<SpinConfig> {
  const row = await trx
    .selectFrom('spin_config')
    .selectAll()
    .where('id', '=', tableId)
    .where('is_active', '=', true)
    .executeTakeFirst();
  if (!row) {
    throw new AppError('SPIN_CONFIG_MISSING', 'Spin config is missing', 500);
  }
  return {
    id: row.id,
    ticketCoin: Number(row.ticket_coin),
    maxEvCoin: Number(row.max_ev_coin),
    dailyCap: row.daily_cap,
    pityThreshold: row.pity_threshold,
    prizes: validatePrizeTable(row.prizes, Number(row.max_ev_coin), mode),
    freeTableId: row.free_table_id,
  };
}

function tableIdFor(feature: SpinFeature, mode: SpinMode): string {
  if (!feature.enabled) {
    throw new AppError('FEATURE_DISABLED', 'Spin is not enabled for this region', 404);
  }
  const tableId = mode === 'paid' ? feature.tableId : feature.freeTableId;
  if (!tableId) {
    throw new AppError('SPIN_CONFIG_MISSING', 'Spin config is missing', 500);
  }
  return tableId;
}

async function countSpinsToday(
  trx: Transaction<DB>,
  userId: string,
  configId: string,
  mode: SpinMode,
  window: { start: Date; end: Date },
): Promise<number> {
  const row = await trx
    .selectFrom('spin_history')
    .select((eb) => eb.fn.count<string>('id').as('count'))
    .where('user_id', '=', userId)
    .where('spin_config_id', '=', configId)
    .where('mode', '=', mode)
    .where('created_at', '>=', window.start)
    .where('created_at', '<', window.end)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function pityEligible(
  trx: Transaction<DB>,
  userId: string,
  config: SpinConfig,
): Promise<boolean> {
  if (config.pityThreshold <= 0) return false;
  const rows = await trx
    .selectFrom('spin_history')
    .select(['prize_slot'])
    .where('user_id', '=', userId)
    .where('spin_config_id', '=', config.id)
    .where('mode', '=', 'paid')
    .orderBy('created_at', 'desc')
    .limit(config.pityThreshold)
    .execute();
  if (rows.length < config.pityThreshold) return false;
  const prizeBySlot = new Map(config.prizes.map((prize) => [prize.slot, prize]));
  return rows.every((row) => {
    const prize = prizeBySlot.get(row.prize_slot);
    return prize?.tier !== 'high' && prize?.tier !== 'jackpot';
  });
}

export async function getSpinState(userId: string): Promise<SpinStateResponse> {
  return db.transaction().execute(async (trx) => {
    const user = await loadUserForSpin(userId, trx);
    const feature = await getSpinFeature(user.regionId);
    const config = await loadConfig(trx, tableIdFor(feature, 'paid'), 'paid');
    const freeConfig = await loadConfig(trx, tableIdFor(feature, 'free'), 'free');
    const paidWindow = dayWindow(feature.timezone);
    const spinsToday = await countSpinsToday(trx, userId, config.id, 'paid', paidWindow);
    const freeSpinsToday = await countSpinsToday(trx, userId, freeConfig.id, 'free', paidWindow);

    // Spins are ad-funded, so the spin cap alone is not what the user can actually do — running out
    // of luckyspin ad quota strands them on a wheel that says "20 left". Reported as the smaller of
    // the two, with the ad numbers alongside so the UI can explain which limit it hit.
    const adFeature = await getRewardedAdsFeature(user.regionId);
    const adState = await buildState(trx, userId, adFeature, new Date(), 'luckyspin');
    const spinsRemaining = Math.min(
      Math.max(0, config.dailyCap - spinsToday),
      adState.rewards_remaining,
    );

    return {
      ticket_coin: config.ticketCoin.toString(),
      spins_today: spinsToday,
      spins_remaining: spinsRemaining,
      daily_cap: config.dailyCap,
      ads_remaining: adState.rewards_remaining,
      next_ad_available_at: adState.next_available_at,
      free_spin_available: freeSpinsToday === 0 && adState.rewards_remaining > 0,
      reset_at: paidWindow.end.toISOString(),
      odds_disclosure: feature.oddsDisclosure,
      paid_prizes_display: prizeDisplay(config.prizes),
      free_prizes_display: prizeDisplay(freeConfig.prizes),
      prizes_display: prizeDisplay(config.prizes),
    };
  });
}

// Every spin — free or paid — is funded by a rewarded ad. The intent is the server's only proof
// that the ad was actually watched: the app used to gate spins on a client-side boolean, which meant
// calling POST /spin directly skipped the ad entirely.
async function assertSpinAdIntent(
  trx: Transaction<DB>,
  userId: string,
  intentId: string,
): Promise<void> {
  const intent = await trx
    .selectFrom('rewarded_ad_intents')
    .select(['user_id', 'status', 'placement', 'spin_history_id'])
    .where('id', '=', intentId)
    .forUpdate()
    .executeTakeFirst();

  // One error code for every rejection, deliberately: telling a caller *which* of these it tripped
  // would let them probe for other users' intent ids.
  //
  // The `pending` case is the one worth knowing about client-side — AdMob's SSV callback is
  // server-to-server and can land after the app's own POST /spin. That is a retry, not a failure.
  if (intent === undefined) {
    throw adNotVerified();
  }
  if (
    intent.user_id !== userId ||
    intent.status !== 'consumed' ||
    intent.spin_history_id !== null ||
    (intent.placement !== null && intent.placement !== 'luckyspin')
  ) {
    throw adNotVerified();
  }
}

function adNotVerified(): AppError {
  return new AppError(
    'AD_NOT_VERIFIED',
    'No verified rewarded ad for this spin — retry shortly if the ad just finished',
    403,
  );
}

async function performSpin(
  userId: string,
  mode: SpinMode,
  intentId: string,
): Promise<SpinResponse> {
  return db.transaction().execute(async (trx) => {
    const user = await loadUserForSpin(userId, trx);
    const feature = await getSpinFeature(user.regionId);
    const config = await loadConfig(trx, tableIdFor(feature, mode), mode);
    const spinHistoryId = uuidv7();
    const today = dayWindow(feature.timezone);

    await assertSpinAdIntent(trx, userId, intentId);

    const wallet = await trx
      .selectFrom('wallets')
      .selectAll()
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!wallet) {
      throw new AppError('WALLET_NOT_FOUND', 'Wallet not found', 404);
    }

    const spinsToday = await countSpinsToday(trx, userId, config.id, mode, today);
    if (mode === 'paid' && spinsToday >= config.dailyCap) {
      throw new AppError('DAILY_CAP_REACHED', 'Daily spin cap reached', 429);
    }
    if (mode === 'free' && spinsToday > 0) {
      throw new AppError('FREE_SPIN_ALREADY_CLAIMED', 'Free spin already claimed today', 429);
    }

    // No SPIN_TICKET_DEBIT: the ad paid for this spin, not the wallet. The balance only moves if a
    // prize is credited below.
    let newBalance = wallet.available_coin;

    const pityApplied = mode === 'paid' ? await pityEligible(trx, userId, config) : false;
    const adjustedPrizes = applyPity(config.prizes, pityApplied);
    const rollResult = roll();
    const prize = selectPrize(adjustedPrizes, rollResult.rollFraction);

    if (prize.type !== 'coin') {
      throw new AppError(
        'SPIN_PRIZE_UNSUPPORTED',
        'This spin prize type is not available yet',
        503,
      );
    }
    if (typeof prize.value === 'number' && prize.value > 0) {
      const credit = await creditInTransaction(trx, {
        userId,
        entryType: mode === 'paid' ? 'SPIN_PRIZE_CREDIT' : 'FREE_SPIN_PRIZE_CREDIT',
        amount: prize.value,
        bucket: 'available',
        refType: 'spin',
        refId: spinHistoryId,
        note: mode === 'paid' ? 'paid_spin=true' : 'free_spin=true',
      });
      newBalance = credit.balanceAfter;
    }

    await trx
      .insertInto('spin_history')
      .values({
        id: spinHistoryId,
        user_id: userId,
        spin_config_id: config.id,
        server_seed: rollResult.seed,
        server_seed_hash: rollResult.seedHash,
        roll: rollResult.rollString,
        prize_slot: prize.slot,
        prize_type: prize.type,
        prize_value: String(prize.value),
        pity_applied: pityApplied,
        mode,
      })
      .execute();

    // Burns the intent. assertSpinAdIntent already holds a row lock, so a concurrent request blocks
    // there and re-reads a spent intent — but this is where a free spin would be minted if that ever
    // stopped holding, so the zero-row case aborts the transaction rather than passing silently.
    const burned = await trx
      .updateTable('rewarded_ad_intents')
      .set({ spin_history_id: spinHistoryId })
      .where('id', '=', intentId)
      .where('spin_history_id', 'is', null)
      .executeTakeFirst();
    if (burned.numUpdatedRows === 0n) {
      throw new AppError('AD_NOT_VERIFIED', 'This rewarded ad has already been spent', 403);
    }

    return {
      prize_slot: prize.slot,
      prize_type: prize.type,
      prize_value: String(prize.value),
      new_balance: newBalance,
    };
  });
}

export async function performPaidSpin(userId: string, intentId: string): Promise<SpinResponse> {
  return performSpin(userId, 'paid', intentId);
}

export async function performFreeSpin(userId: string, intentId: string): Promise<SpinResponse> {
  return performSpin(userId, 'free', intentId);
}
