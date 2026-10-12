import ipaddr from 'ipaddr.js';

// ipaddr.process() normalizes IPv4-mapped IPv6 addresses (e.g. "::ffff:127.0.0.1", what Node gives
// back for IPv4 peers on a dual-stack socket) to plain IPv4 before matching, so allowlist CIDRs can
// stay in whichever family the network's dashboard publishes them in.
export function isIpAllowed(ip: string, allowedCidrs: readonly string[]): boolean {
  if (allowedCidrs.length === 0) return false;

  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip);
  } catch {
    return false;
  }

  return allowedCidrs.some((cidr) => {
    try {
      const range = ipaddr.parseCIDR(cidr);
      return addr.kind() === range[0].kind() && addr.match(range);
    } catch {
      return false;
    }
  });
}
