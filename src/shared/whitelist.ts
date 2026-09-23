/**
 * Host helpers shared by the background worker and the content script.
 *
 * Kept free of chrome.* APIs so the content script can use the exact same
 * matching logic the background uses to install whitelist rules.
 */

/** Extracts a normalised hostname from a URL, or null when not http(s). */
export function hostFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Extracts a hostname from an origin such as "https://example.com". */
export function hostFromOrigin(origin: string | undefined | null): string | null {
  if (!origin) return null;
  return hostFromUrl(origin.endsWith('/') ? origin : `${origin}/`);
}

/**
 * True when `host` is the whitelisted entry itself or a subdomain of it.
 * Whitelisting "example.com" therefore also covers "www.example.com" and
 * "cdn.example.com", which is what people expect.
 */
export function hostMatchesEntry(host: string, entry: string): boolean {
  const normalizedEntry = entry.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  if (!normalizedEntry) return false;
  return host === normalizedEntry || host.endsWith(`.${normalizedEntry}`);
}

export function isWhitelisted(host: string, whitelist: readonly string[]): boolean {
  return whitelist.some((entry) => hostMatchesEntry(host, entry));
}

/** Adds or removes a host, keeping the list sorted and free of duplicates. */
export function toggleWhitelistEntry(
  whitelist: readonly string[],
  host: string,
  allowed: boolean,
): string[] {
  const set = new Set(whitelist);
  if (allowed) set.add(host);
  else {
    for (const entry of [...set]) {
      if (hostMatchesEntry(host, entry) || hostMatchesEntry(entry, host)) set.delete(entry);
    }
  }
  return [...set].sort();
}

/**
 * Converts a user-entered subscription URL into something safe to fetch.
 * Accepts a bare hostname and upgrades plain http to https when possible.
 */
export function normalizeSubscriptionUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
