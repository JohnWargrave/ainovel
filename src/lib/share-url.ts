// Builds a public share link as `<base>/<segment>`. Undefined when the base is unset or not a plain
// https URL: without a registered deeplink/landing host there is no correct link, and an absent
// field beats one that goes nowhere.
export function shareUrl(base: string | undefined, segment: string): string | undefined {
  if (!base) return undefined;
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(segment)}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}
