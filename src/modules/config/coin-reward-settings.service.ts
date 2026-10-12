import type { Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';

export const MAX_COIN_REWARD = 10_000_000;

export interface CoinRewardSettings {
  welcome_coin: number;
  google_login: number;
  updated_at: Date;
}

export interface LoginRewardOffer {
  auth_provider: 'password' | 'google';
  welcome_coin: number;
  provider_bonus_coin: number;
  total_coin: number;
}

const SETTINGS_ID = 'global';

export async function getCoinRewardSettings(): Promise<CoinRewardSettings> {
  return db
    .selectFrom('coin_reward_settings')
    .select(['welcome_coin', 'google_login', 'updated_at'])
    .where('id', '=', SETTINGS_ID)
    .executeTakeFirstOrThrow();
}

export async function listLoginRewardOffers(): Promise<{
  items: LoginRewardOffer[];
  updated_at: Date;
}> {
  const settings = await getCoinRewardSettings();
  return {
    items: [
      {
        auth_provider: 'password',
        welcome_coin: settings.welcome_coin,
        provider_bonus_coin: 0,
        total_coin: settings.welcome_coin,
      },
      {
        auth_provider: 'google',
        welcome_coin: settings.welcome_coin,
        provider_bonus_coin: settings.google_login,
        total_coin: settings.welcome_coin + settings.google_login,
      },
    ],
    updated_at: settings.updated_at,
  };
}

export async function getCoinRewardSettingsInTransaction(
  trx: Transaction<DB>,
): Promise<CoinRewardSettings> {
  return trx
    .selectFrom('coin_reward_settings')
    .select(['welcome_coin', 'google_login', 'updated_at'])
    .where('id', '=', SETTINGS_ID)
    .executeTakeFirstOrThrow();
}
