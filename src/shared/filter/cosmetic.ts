/**
 * Compiles cosmetic filter rules (`##`, `#@#`, `#?#`) into a bundle that the
 * content script turns into a stylesheet.
 *
 * Layout of the bundle is chosen for fast lookup at `document_start`:
 *
 *   generic       selectors hidden on every page
 *   genericAllow  selectors never hidden (`#@#`)
 *   specific      domain -> selectors hidden on that domain and subdomains
 *   specificAllow domain -> selectors un-hidden on that domain and subdomains
 *   complex       rules with `~domain` exclusions or wildcards, matched linearly
 *
 * Procedural rules (`#?#`, `#@?#`) are recognised but never installed: they
 * need a scriptlet engine that is explicitly out of scope.
 */

import { COSMETIC_LIMITS } from '../constants.ts';
import type { CosmeticEntry } from './parse.ts';

export type ComplexCosmeticRule = {
  selector: string;
  include: string[];
  exclude: string[];
  exception: boolean;
};

export type CosmeticBundle = {
  version: number;
  generic: string[];
  genericAllow: string[];
  specific: Record<string, string[]>;
  specificAllow: Record<string, string[]>;
  complex: ComplexCosmeticRule[];
  counts: {
    generic: number;
    genericAllow: number;
    specific: number;
    complex: number;
    proceduralSkipped: number;
    domains: number;
  };
};

export type CosmeticCompileResult = {
  bundle: CosmeticBundle;
  /** Selectors that were dropped because of COSMETIC_LIMITS. */
  dropped: number;
};

/**
 * Version counter. Every rebuilt bundle gets a fresh version so that the
 * per-host selector cache can never serve results from a previous bundle.
 * Seeded from the clock purely so the number is recognisable in debugging.
 */
let versionCounter = Math.floor(Date.now() / 1000) % 1_000_000;

export function emptyBundle(): CosmeticBundle {
  return {
    version: ++versionCounter,
    generic: [],
    genericAllow: [],
    specific: {},
    specificAllow: {},
    complex: [],
    counts: {
      generic: 0,
      genericAllow: 0,
      specific: 0,
      complex: 0,
      proceduralSkipped: 0,
      domains: 0,
    },
  };
}

/**
 * Adblock domain matching: the host equals the domain, or is a subdomain of it.
 * A leading `*.` is accepted and ignored. A `*` anywhere else turns the domain
 * into a glob, which is rare but present in some lists.
 */
export function domainMatches(host: string, domain: string): boolean {
  let pattern = domain;
  if (pattern.startsWith('*.')) pattern = pattern.slice(2);
  if (!pattern) return false;
  if (pattern === host) return true;
  if (!pattern.includes('*')) {
    return host.endsWith('.' + pattern);
  }
  const regex = new RegExp(
    '^' +
      pattern
        .split('.')
        .map((part) =>
          part === '*'
            ? '[^.]+'
            : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('\\.') +
      '$',
  );
  return regex.test(host);
}

function pushCapped(map: Record<string, string[]>, domain: string, selector: string): boolean {
  const existing = map[domain];
  if (existing) {
    if (existing.length >= COSMETIC_LIMITS.maxSelectorsPerDomain) return false;
    existing.push(selector);
    return true;
  }
  if (Object.keys(map).length >= COSMETIC_LIMITS.maxDomains) return false;
  map[domain] = [selector];
  return true;
}

/**
 * Compiles every cosmetic line of a list into a single bundle contribution.
 * `existing` is the accumulated bundle so far; caps are applied globally.
 */
export function compileCosmetic(
  entries: CosmeticEntry[],
  existing: CosmeticBundle,
): CosmeticCompileResult {
  const bundle = existing;
  let dropped = 0;
  let totalSelectors =
    bundle.generic.length +
    bundle.genericAllow.length +
    Object.values(bundle.specific).reduce((sum, list) => sum + list.length, 0) +
    Object.values(bundle.specificAllow).reduce((sum, list) => sum + list.length, 0);

  const totalSelectorBudget = () =>
    totalSelectors < COSMETIC_LIMITS.maxSelectors;

  for (const entry of entries) {
    if (entry.procedural) {
      bundle.counts.proceduralSkipped++;
      continue;
    }

    // Generic rules go into flat arrays; site-specific rules into domain maps.
    const domainMap = entry.exception ? bundle.specificAllow : bundle.specific;
    const genericList = entry.exception ? bundle.genericAllow : bundle.generic;

    if (!entry.domains) {
      if (!totalSelectorBudget()) {
        dropped++;
        continue;
      }
      genericList.push(entry.selector);
      totalSelectors++;
      if (entry.exception) bundle.counts.genericAllow++;
      else bundle.counts.generic++;
      continue;
    }

    const simple = entry.domains.filter((d) => !d.includes('*'));
    const wildcard = entry.domains.filter((d) => d.includes('*'));
    if (entry.excludedDomains.length > 0 || wildcard.length > 0) {
      // Rare enough to keep off the hot path entirely.
      if (bundle.complex.length < 5_000) {
        bundle.complex.push({
          selector: entry.selector,
          include: entry.domains,
          exclude: entry.excludedDomains,
          exception: entry.exception,
        });
        bundle.counts.complex++;
      } else {
        dropped++;
      }
      continue;
    }

    let stored = false;
    for (const domain of simple) {
      if (!totalSelectorBudget()) {
        dropped++;
        break;
      }
      if (pushCapped(domainMap, domain, entry.selector)) {
        stored = true;
        totalSelectors++;
      } else {
        dropped++;
      }
    }
    if (stored) {
      bundle.counts.specific++;
      bundle.counts.domains = Object.keys(bundle.specific).length;
    }
  }

  return { bundle, dropped };
}

/**
 * Cache of resolved selectors per host. Keyed by bundle version as well as
 * host: a rebuilt bundle has a new version, so results can never leak from one
 * bundle into the next.
 */
const cache = new Map<string, string[]>();

/**
 * Returns the selectors that must be hidden for `host`.
 * Specific exceptions beat specific and generic hides; generic exceptions
 * beat generic hides.
 */
export function selectorsForHost(bundle: CosmeticBundle, host: string): string[] {
  const cacheKey = `${bundle.version}:${host}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const allowed = new Set<string>(bundle.genericAllow);
  const selected = new Set<string>(bundle.generic);

  const specific = bundle.specific[host];
  if (specific) {
    for (const selector of specific) selected.add(selector);
  }
  const specificAllow = bundle.specificAllow[host];
  if (specificAllow) {
    for (const selector of specificAllow) allowed.add(selector);
  }

  if (Object.keys(bundle.specific).length > 0 || bundle.complex.length > 0) {
    for (const domain of Object.keys(bundle.specific)) {
      if (domainMatches(host, domain)) {
        for (const selector of bundle.specific[domain]) selected.add(selector);
      }
    }
    for (const domain of Object.keys(bundle.specificAllow)) {
      if (domainMatches(host, domain)) {
        for (const selector of bundle.specificAllow[domain]) allowed.add(selector);
      }
    }
    for (const rule of bundle.complex) {
      if (rule.exception) {
        if (rule.include.some((d) => domainMatches(host, d))) allowed.add(rule.selector);
        continue;
      }
      const included = rule.include.some((d) => domainMatches(host, d));
      if (!included) continue;
      if (rule.exclude.some((d) => domainMatches(host, d))) continue;
      selected.add(rule.selector);
    }
  }

  const result: string[] = [];
  for (const selector of selected) {
    if (allowed.has(selector)) continue;
    result.push(selector);
  }
  if (cache.size > 512) cache.clear();
  cache.set(cacheKey, result);
  return result;
}

/** Drops the per-host cache; called whenever a new bundle is stored. */
export function clearSelectorCache(): void {
  cache.clear();
}

/** Builds the stylesheet text injected by the content script. */
export function selectorsToCss(selectors: string[]): string {
  if (selectors.length === 0) return '';
  // One rule per selector so that a single bad selector only invalidates
  // itself instead of the whole stylesheet.
  return selectors.map((s) => `${s}{display:none!important}`).join('\n');
}
