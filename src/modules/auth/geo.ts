import geoip from 'geoip-lite';

const DEFAULT_REGION = 'ROW';
// Mirrors the region_config seed (1700000000014): only VN is explicitly mapped so far, everything
// else — including unresolved lookups — falls into ROW (rest-of-world).
const COUNTRY_TO_REGION: Record<string, string> = {
  VN: 'VN',
};

export interface ResolvedRegion {
  countryCode: string;
  regionId: string;
}

export function resolveRegion(ip: string): ResolvedRegion {
  const lookup = geoip.lookup(ip);
  const countryCode = lookup?.country ?? 'XX';
  const regionId = COUNTRY_TO_REGION[countryCode] ?? DEFAULT_REGION;
  return { countryCode, regionId };
}
