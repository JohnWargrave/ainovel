import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';

export interface NetworkConfig {
  network: string;
  secretKey: string;
  allowedIps: string[];
  currencyPerUsd: string | null;
  holdHours: number;
  highValueThresholdUsd: number;
  highValueHoldHours: number;
  creditImmediately: boolean;
  shadowMode: boolean;
  signatureFormat: 'hmac-sha256' | 'md5';
  signatureFields: string[];
  signatureParam: string;
  reversalValues: string[];
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
}

function configuredSecret(network: string, databaseSecret: string): string {
  const override =
    network === 'tapjoy'
      ? env.TAPJOY_POSTBACK_SECRET
      : network === 'pubscale'
        ? env.PUBSCALE_POSTBACK_SECRET
        : undefined;
  const secret = nonEmpty(override) ?? databaseSecret;
  if (env.NODE_ENV === 'production' && secret.startsWith('dev-placeholder-')) {
    throw new AppError('NETWORK_NOT_CONFIGURED', `${network} credentials are not configured`, 503);
  }
  return secret;
}

// No caching yet — volume at this milestone's scale doesn't need it, and network_config is meant
// to be admin-editable without a redeploy (see plan's rationale for keeping it DB- rather than
// env-driven), so a cache would need its own invalidation story this milestone doesn't require.
export async function getNetworkConfig(network: string): Promise<NetworkConfig> {
  const row = await db
    .selectFrom('network_config')
    .selectAll()
    .where('network', '=', network)
    .executeTakeFirst();
  if (!row?.is_active) {
    throw new AppError('NETWORK_NOT_FOUND', `Unknown or inactive network ${network}`, 404);
  }
  return {
    network: row.network,
    secretKey: configuredSecret(network, row.secret_key),
    allowedIps: row.allowed_ips,
    currencyPerUsd: row.currency_per_usd,
    holdHours: row.hold_hours,
    highValueThresholdUsd: Number(row.high_value_threshold_usd),
    highValueHoldHours: row.high_value_hold_hours,
    creditImmediately: row.credit_immediately,
    shadowMode: row.shadow_mode,
    signatureFormat: row.signature_format === 'md5' ? 'md5' : 'hmac-sha256',
    signatureFields: row.signature_fields,
    signatureParam: row.signature_param,
    reversalValues: row.reversal_values,
  };
}
