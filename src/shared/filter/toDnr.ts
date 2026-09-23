/**
 * Converts parsed filter rules into declarativeNetRequest rule candidates.
 *
 * The translation is deliberately conservative. When a rule cannot be mapped
 * with confidence it is dropped and counted, because a wrong rule either
 * breaks a page or blocks nothing. Dropped rules are reported per subscription
 * in the options page so the loss is visible instead of silent.
 */

import { BLOCKABLE_RESOURCE_TYPES, PRIORITY } from '../constants.ts';
import type { NetworkEntry, ResourceTypeName } from './parse.ts';

export type DnrResourceType = (typeof BLOCKABLE_RESOURCE_TYPES)[number] | 'main_frame';

export type DomainType = 'thirdParty' | 'firstParty';

export type RuleCondition = {
  urlFilter?: string;
  regexFilter?: string;
  isUrlFilterCaseSensitive?: boolean;
  resourceTypes?: DnrResourceType[];
  excludedResourceTypes?: DnrResourceType[];
  domainType?: DomainType;
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  /**
   * Set by rule compaction instead of `urlFilter`: a rule carrying only
   * `requestDomains` matches every request to those domains and their
   * subdomains.
   */
  requestDomains?: string[];
  excludedRequestDomains?: string[];
};

/** A rule before an id has been assigned. */
export type CandidateRule = {
  priority: number;
  action: 'block' | 'allow';
  condition: RuleCondition;
  /** Subscription id the rule came from. */
  source: string;
  /** Position inside that subscription, for stable ordering. */
  order: number;
  /**
   * Budget tier, lower wins when Chrome's rule limit is hit:
   * 0 = important / user rule, 1 = exception (`@@`), 2 = ordinary block.
   */
  tier: 0 | 1 | 2;
};

export type DropReason =
  | 'unsupported-option'
  | 'invalid-pattern'
  | 'main-frame-only'
  | 'regex-unsupported'
  | 'regex-too-complex'
  | 'no-resource-types';

export type ConversionContext = {
  /** Subscription id the rule came from, for budget accounting. */
  source: string;
  /** Position inside that subscription, for stable ordering. */
  order: number;
  /** Rules the user typed themselves outrank list rules. */
  isCustom: boolean;
};

export type ConversionResult =
  | { ok: true; rule: CandidateRule }
  | { ok: false; reason: DropReason };

/** Adblock resource-type option -> declarativeNetRequest resource type. */
const TYPE_MAP: Record<Exclude<ResourceTypeName, 'csp' | 'all'>, DnrResourceType> = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  object: 'object',
  xmlhttprequest: 'xmlhttprequest',
  subdocument: 'sub_frame',
  document: 'main_frame',
  ping: 'ping',
  font: 'font',
  media: 'media',
  websocket: 'websocket',
  other: 'other',
};

/** RE2 does not implement these; such a rule would be silently discarded. */
const REGEX_UNSUPPORTED = /\(\?<?[=!]|\\[1-9]|\(\?\(/;

/**
 * Limits on regex rules. Chrome rejects a rule whose compiled RE2 program
 * exceeds 2KB, and the compiled size is a poor proxy for the source length: a
 * 200-character pattern like `^https?://.*\.(a|b|c|...)\/.*` compiles into a
 * program many times that size, because `.*` in front of a large alternation
 * expands into a big automaton. Since one rejected rule makes Chrome refuse
 * the whole batch, the shape is checked as well as the length.
 */
const MAX_REGEX_SOURCE = 256;
const MAX_REGEX_ALTERNATIVES = 12;

const BLOCKABLE = new Set<string>(BLOCKABLE_RESOURCE_TYPES);

function resolveResourceTypes(entry: NetworkEntry): Set<DnrResourceType> | null {
  const { types, excludedTypes } = entry.options;
  if (types.includes('all')) {
    return new Set<DnrResourceType>(BLOCKABLE_RESOURCE_TYPES);
  }
  let selected: Set<DnrResourceType>;
  if (types.length === 0) {
    selected = new Set<DnrResourceType>(BLOCKABLE_RESOURCE_TYPES);
  } else {
    selected = new Set<DnrResourceType>();
    for (const type of types) {
      if (type === 'csp' || type === 'all') continue;
      selected.add(TYPE_MAP[type]);
    }
  }
  for (const type of excludedTypes) {
    if (type === 'all') return null;
    if (type === 'csp') continue;
    selected.delete(TYPE_MAP[type]);
  }
  // `main_frame` is never blocked: see BLOCKABLE_RESOURCE_TYPES.
  if (selected.has('main_frame')) {
    selected.delete('main_frame');
  }
  if (selected.size === 0) return null;
  for (const type of selected) {
    if (!BLOCKABLE.has(type)) return null;
  }
  return selected;
}

/**
 * A pattern with no alphanumeric character is either a wildcard that matches
 * every URL on the internet, or an anchor-only fragment. Neither is useful, and
 * the former would be catastrophic, so both are dropped.
 */
function isSafePattern(pattern: string): boolean {
  return /[a-z0-9]/i.test(pattern);
}

export function networkEntryToRule(entry: NetworkEntry, context: ConversionContext): ConversionResult {
  if (entry.options.unsupported.length > 0) {
    return { ok: false, reason: 'unsupported-option' };
  }
  if (entry.options.types.includes('csp') && entry.options.types.length === 1) {
    return { ok: false, reason: 'unsupported-option' };
  }

  const resourceTypes = resolveResourceTypes(entry);
  if (!resourceTypes) {
    return { ok: false, reason: 'no-resource-types' };
  }

  const condition: RuleCondition = {};
  if (entry.isRegex) {
    if (!entry.pattern || !isSafePattern(entry.pattern)) {
      return { ok: false, reason: 'invalid-pattern' };
    }
    if (REGEX_UNSUPPORTED.test(entry.pattern)) {
      return { ok: false, reason: 'regex-unsupported' };
    }
    if (entry.pattern.length > MAX_REGEX_SOURCE) {
      return { ok: false, reason: 'regex-too-complex' };
    }
    if ((entry.pattern.match(/\|/g) ?? []).length > MAX_REGEX_ALTERNATIVES) {
      return { ok: false, reason: 'regex-too-complex' };
    }
    condition.regexFilter = entry.pattern;
  } else {
    if (!isSafePattern(entry.pattern)) {
      return { ok: false, reason: 'invalid-pattern' };
    }
    condition.urlFilter = entry.pattern;
    if (entry.options.matchCase) condition.isUrlFilterCaseSensitive = true;
  }

  if (entry.options.thirdParty === true) condition.domainType = 'thirdParty';
  else if (entry.options.thirdParty === false) condition.domainType = 'firstParty';

  if (entry.options.domains.length > 0) {
    condition.initiatorDomains = [...new Set(entry.options.domains)];
  }
  if (entry.options.excludedDomains.length > 0) {
    condition.excludedInitiatorDomains = [...new Set(entry.options.excludedDomains)];
  }

  condition.resourceTypes = [...resourceTypes].sort();

  const tier: CandidateRule['tier'] = entry.exception
    ? 1
    : entry.options.important || context.isCustom
      ? 0
      : 2;

  const priority = entry.exception
    ? context.isCustom
      ? PRIORITY.customAllow
      : PRIORITY.listAllow
    : tier === 0
      ? context.isCustom
        ? PRIORITY.customBlock
        : PRIORITY.listImportantBlock
      : PRIORITY.listBlock;

  return {
    ok: true,
    rule: {
      priority,
      action: entry.exception ? 'allow' : 'block',
      condition,
      source: context.source,
      order: context.order,
      tier,
    },
  };
}

/** Stable key used to de-duplicate rules that differ only in origin. */
export function ruleKey(rule: CandidateRule): string {
  const c = rule.condition;
  return JSON.stringify([
    rule.action,
    c.urlFilter ?? null,
    c.regexFilter ?? null,
    c.isUrlFilterCaseSensitive ?? null,
    c.resourceTypes ?? null,
    c.domainType ?? null,
    c.initiatorDomains ?? null,
    c.excludedInitiatorDomains ?? null,
  ]);
}
