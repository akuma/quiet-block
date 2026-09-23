/**
 * Rule compaction.
 *
 * Chrome allows an extension at most 30,000 dynamic rules. EasyList and
 * EasyPrivacy together contain around 100,000 network rules, most of which are
 * the same shape: `||some-ad-domain^`.
 *
 * declarativeNetRequest lets a rule carry a list of `requestDomains` and no
 * `urlFilter` at all, in which case it matches every request to those domains
 * and their subdomains - which is precisely what `||domain^` means. So all the
 * plain domain rules that share the same options are merged into a handful of
 * rules carrying a hundred domains each.
 *
 * This is what makes it possible to install complete lists instead of a
 * truncated sample: the same ~98,000 rules become ~1,300 real rules.
 *
 * Rules are only ever merged inside a single subscription, so each list keeps
 * its own contiguous block of rule ids and can be re-compiled or disabled on
 * its own.
 */

import type { CandidateRule, RuleCondition } from './toDnr.ts';

/** Domains per merged rule. Kept modest so no single rule grows unwieldy. */
export const DOMAINS_PER_RULE = 100;

/** A candidate that also remembers how many source rules it stands for. */
export type CompactedRule = CandidateRule & { sourceRules: number };

/**
 * Matches a urlFilter that is exactly `||domain^` where `domain` is a plain
 * hostname. Anything with a path, a wildcard or a partial-hostname suffix is
 * left alone: those are not equivalent to a domain match.
 */
const PLAIN_DOMAIN_PATTERN =
  /^\|\|([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)\^$/;

/**
 * Returns the domain when `rule` is a plain `||domain^` rule that can be
 * expressed as a domain match, or null when it must stay a url filter.
 *
 * Rules scoped by `initiatorDomains` are excluded: there the url filter matches
 * the request while the domains match the page, so folding the pattern into
 * `requestDomains` would change which requests the rule applies to.
 */
export function compactableDomain(rule: CandidateRule): string | null {
  const condition = rule.condition;
  if (condition.initiatorDomains || condition.excludedInitiatorDomains) return null;
  if (condition.isUrlFilterCaseSensitive) return null;
  if (condition.regexFilter !== undefined) return null;
  if (!condition.urlFilter) return null;
  const match = PLAIN_DOMAIN_PATTERN.exec(condition.urlFilter);
  return match ? match[1]! : null;
}

/** Everything about a rule except the pattern it matches. */
function signatureOf(rule: CandidateRule): string {
  const condition = rule.condition;
  return JSON.stringify([
    rule.action,
    rule.priority,
    rule.tier,
    condition.domainType ?? null,
    condition.resourceTypes ?? null,
    condition.excludedResourceTypes ?? null,
  ]);
}

function conditionFor(template: CandidateRule, domains: string[]): RuleCondition {
  const condition: RuleCondition = { requestDomains: domains };
  if (template.condition.domainType !== undefined) {
    condition.domainType = template.condition.domainType;
  }
  if (template.condition.resourceTypes !== undefined) {
    condition.resourceTypes = template.condition.resourceTypes;
  }
  if (template.condition.excludedResourceTypes !== undefined) {
    condition.excludedResourceTypes = template.condition.excludedResourceTypes;
  }
  return condition;
}

export type CompactReport = {
  /** Rules after merging. */
  ruleCount: number;
  /** Source rules those merged rules stand for. */
  sourceRuleCount: number;
  /** Domains folded into `requestDomains` lists. */
  mergedDomains: number;
};

/**
 * Merges the plain domain rules of one subscription. The output order is
 * deterministic: rule tier first, then position in the source list, so the
 * same input always produces the same rule ids.
 */
export function compactCandidates(rules: CandidateRule[]): {
  rules: CompactedRule[];
  report: CompactReport;
} {
  const plain: CompactedRule[] = [];
  const groups = new Map<string, { template: CandidateRule; domains: string[] }>();

  for (const rule of rules) {
    const domain = compactableDomain(rule);
    if (domain === null) {
      plain.push({ ...rule, sourceRules: 1 });
      continue;
    }
    const key = signatureOf(rule);
    let group = groups.get(key);
    if (!group) {
      group = { template: rule, domains: [] };
      groups.set(key, group);
    }
    group.domains.push(domain);
  }

  const merged: CompactedRule[] = [];
  let mergedDomains = 0;
  for (const { template, domains } of groups.values()) {
    const unique = [...new Set(domains)].sort();
    if (unique.length < 2) {
      // Nothing to gain from merging a single domain, and a `requestDomains`
      // condition is a slightly different matcher from a url filter - notably
      // for hosts that are IP literals. Keep the original rule.
      merged.push({ ...template, sourceRules: 1 });
      continue;
    }
    for (let index = 0; index < unique.length; index += DOMAINS_PER_RULE) {
      const chunk = unique.slice(index, index + DOMAINS_PER_RULE);
      merged.push({
        ...template,
        condition: conditionFor(template, chunk),
        sourceRules: chunk.length,
      });
    }
    mergedDomains += unique.length;
  }

  const output = [...plain, ...merged].sort((a, b) => a.tier - b.tier || a.order - b.order);
  return {
    rules: output,
    report: {
      ruleCount: output.length,
      sourceRuleCount: rules.length,
      mergedDomains,
    },
  };
}
