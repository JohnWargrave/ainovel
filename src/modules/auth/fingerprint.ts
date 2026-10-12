import crypto from 'node:crypto';

export interface DeviceFingerprintInput {
  gaid: string;
  model: string;
  os: string;
  buildProps?: Record<string, string> | undefined;
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeInstallationId(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === ZERO_UUID || !UUID_PATTERN.test(normalized)) return null;
  return normalized;
}

export function normalizeGaid(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === ZERO_UUID || !UUID_PATTERN.test(normalized)) return null;
  return normalized;
}

export function computeInstallationFingerprint(installationId: string): string {
  return crypto.createHash('sha256').update(`installation:${installationId}`).digest('hex');
}

// Compatibility only: accounts created before installation identity used this GAID-based material.
// Remove once all supported Android versions have migrated their guest accounts.
export function computeLegacyFingerprint(input: DeviceFingerprintInput): string {
  const buildProps = input.buildProps ?? {};
  const sortedProps = Object.keys(buildProps)
    .sort()
    .map((key) => `${key}=${buildProps[key] ?? ''}`)
    .join(',');
  const material = [input.gaid, input.model, input.os, sortedProps].join('|');
  return crypto.createHash('sha256').update(material).digest('hex');
}
