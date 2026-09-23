/**
 * Unit tests for the filter-list pipeline.
 *
 * Run with `npm test` (node --test). Node's built-in TypeScript support runs
 * these files directly, so there is no build step and no test dependency.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLine, parseList, isValidSelector, parseDomainList } from '../src/shared/filter/parse.ts';
import { networkEntryToRule } from '../src/shared/filter/toDnr.ts';
import { compileList } from '../src/shared/filter/compile.ts';
import { compileCosmetic, emptyBundle, selectorsForHost, domainMatches } from '../src/shared/filter/cosmetic.ts';
import { STARTER_LIST } from '../src/shared/filter/starterList.ts';

const context = (overrides = {}) => ({
  source: 'test',
  order: 0,
  isCustom: false,
  ...overrides,
});

/* ------------------------------- parsing ------------------------------- */

test('ignores comments, headers and blank lines', () => {
  assert.equal(parseLine('').kind, 'ignored');
  assert.equal(parseLine('   ').kind, 'ignored');
  assert.equal(parseLine('! a comment').kind, 'ignored');
  assert.equal(parseLine('[Adblock Plus 2.0]').kind, 'ignored');
});

test('parses a plain network blocking rule', () => {
  const line = parseLine('||ads.example.com^');
  assert.equal(line.kind, 'network');
  assert.equal(line.pattern, '||ads.example.com^');
  assert.equal(line.isRegex, false);
  assert.equal(line.exception, false);
});

test('parses an exception rule', () => {
  const line = parseLine('@@||ads.example.com^$image');
  assert.equal(line.kind, 'network');
  assert.equal(line.exception, true);
  assert.deepEqual(line.options.types, ['image']);
});

test('separates options on the first dollar sign', () => {
  const line = parseLine('/banner-\\d+/$script,third-party');
  assert.equal(line.kind, 'network');
  assert.equal(line.isRegex, true);
  assert.equal(line.pattern, 'banner-\\d+');
  assert.equal(line.options.thirdParty, true);
});

test('parses resource type and negation options', () => {
  const line = parseLine('||example.com^$~script,image');
  assert.deepEqual(line.options.excludedTypes, ['script']);
  assert.deepEqual(line.options.types, ['image']);
});

test('parses domain lists with exclusions', () => {
  const line = parseLine('||example.com^$domain=news.com|~shop.news.com');
  assert.deepEqual(line.options.domains, ['news.com']);
  assert.deepEqual(line.options.excludedDomains, ['shop.news.com']);
});

test('reports unknown options instead of guessing', () => {
  const line = parseLine('||example.com^$removeparam=utm_source');
  assert.equal(line.kind, 'network');
  assert.deepEqual(line.options.unsupported, ['removeparam']);
});

test('parses cosmetic separators, including procedural ones', () => {
  const generic = parseLine('##.ad-banner');
  assert.equal(generic.kind, 'cosmetic');
  assert.equal(generic.domains, null);
  assert.equal(generic.procedural, false);

  const specific = parseLine('news.com##.leaderboard');
  assert.deepEqual(specific.domains, ['news.com']);

  const exception = parseLine('example.com#@#.ad-banner');
  assert.equal(exception.exception, true);

  const procedural = parseLine('example.com#?#div:has(> iframe)');
  assert.equal(procedural.procedural, true);
});

test('does not treat a dollar sign inside a selector as an option separator', () => {
  const line = parseLine('##a[href$=".png"]');
  assert.equal(line.kind, 'cosmetic');
  assert.equal(line.selector, 'a[href$=".png"]');
});

test('rejects malformed selectors', () => {
  assert.equal(isValidSelector(''), false);
  assert.equal(isValidSelector('a[href="unclosed'), false);
  assert.equal(isValidSelector('a { color: red }'), false);
  assert.equal(isValidSelector('/* comment */ .ad'), false);
  assert.equal(isValidSelector('.ad'), true);
  assert.equal(isValidSelector('div > p + span'), true);
});

/* ----------------------------- conversion ------------------------------ */

test('converts a blocking rule to a dynamic rule', () => {
  const line = parseLine('||ads.example.com^$third-party,script');
  const result = networkEntryToRule(line, context());
  assert.equal(result.ok, true);
  assert.equal(result.rule.action, 'block');
  assert.equal(result.rule.condition.urlFilter, '||ads.example.com^');
  assert.equal(result.rule.condition.domainType, 'thirdParty');
  assert.deepEqual(result.rule.condition.resourceTypes, ['script']);
  assert.equal(result.rule.tier, 2);
});

test('never blocks top-level documents', () => {
  const only = parseLine('||example.com^$document');
  assert.equal(networkEntryToRule(only, context()).ok, false);

  const mixed = parseLine('||example.com^$document,script');
  const result = networkEntryToRule(mixed, context());
  assert.equal(result.ok, true);
  assert.deepEqual(result.rule.condition.resourceTypes, ['script']);
});

test('drops rules with unsupported options', () => {
  const line = parseLine('||example.com^$removeparam=utm_source');
  const result = networkEntryToRule(line, context());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported-option');
});

test('maps domain= to initiator domains', () => {
  const line = parseLine('||example.com^$domain=a.com|~b.com');
  const result = networkEntryToRule(line, context());
  assert.deepEqual(result.rule.condition.initiatorDomains, ['a.com']);
  assert.deepEqual(result.rule.condition.excludedInitiatorDomains, ['b.com']);
});

test('rejects patterns that would match every URL', () => {
  for (const pattern of ['*', '|', '^', '||']) {
    const result = networkEntryToRule(
      { kind: 'network', pattern, isRegex: false, exception: false, options: parseLine(`x${pattern}`).options },
      context(),
    );
    assert.equal(result.ok, false, `expected ${pattern} to be rejected`);
  }
});

test('rejects regexes RE2 cannot compile', () => {
  const lookahead = parseLine('/ad(?=vert)/');
  const result = networkEntryToRule(lookahead, context());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'regex-unsupported');
});

test('gives exceptions and custom rules higher priority', () => {
  const block = networkEntryToRule(parseLine('||a.example^'), context());
  const exception = networkEntryToRule(parseLine('@@||a.example^'), context());
  const custom = networkEntryToRule(parseLine('||b.example^'), context({ isCustom: true }));
  assert.ok(block.rule.priority < exception.rule.priority);
  assert.ok(block.rule.priority < custom.rule.priority);
  assert.equal(exception.rule.action, 'allow');
});

test('de-duplicates identical rules', () => {
  const compiled = compileList('||a.example^\n||a.example^\n', { source: 'test' });
  assert.equal(compiled.rules.length, 1);
  assert.equal(compiled.stats.dropped.duplicate, 1);
});

/* ------------------------------ cosmetic ------------------------------- */

test('matches domains and their subdomains', () => {
  assert.equal(domainMatches('example.com', 'example.com'), true);
  assert.equal(domainMatches('www.example.com', 'example.com'), true);
  assert.equal(domainMatches('notexample.com', 'example.com'), false);
  assert.equal(domainMatches('example.com.evil.net', 'example.com'), false);
});

test('generic selectors apply everywhere', () => {
  const bundle = emptyBundle();
  compileCosmetic([parseLine('##.ad')], bundle);
  assert.deepEqual(selectorsForHost(bundle, 'anything.example'), ['.ad']);
});

test('generic exceptions win over generic hides', () => {
  const bundle = emptyBundle();
  compileCosmetic([parseLine('##.ad'), parseLine('#@#.ad')], bundle);
  assert.deepEqual(selectorsForHost(bundle, 'anything.example'), []);
});

test('site-specific rules only apply to their domain', () => {
  const bundle = emptyBundle();
  compileCosmetic([parseLine('news.com##.leaderboard')], bundle);
  assert.deepEqual(selectorsForHost(bundle, 'news.com'), ['.leaderboard']);
  assert.deepEqual(selectorsForHost(bundle, 'www.news.com'), ['.leaderboard']);
  assert.deepEqual(selectorsForHost(bundle, 'other.com'), []);
});

test('site-specific exceptions beat generic hides', () => {
  const bundle = emptyBundle();
  compileCosmetic([parseLine('##.ad'), parseLine('news.com#@#.ad')], bundle);
  assert.deepEqual(selectorsForHost(bundle, 'news.com'), []);
  assert.deepEqual(selectorsForHost(bundle, 'other.com'), ['.ad']);
});

test('domain exclusions are honoured', () => {
  const bundle = emptyBundle();
  compileCosmetic([parseLine('news.com|~shop.news.com##.promo')], bundle);
  assert.deepEqual(selectorsForHost(bundle, 'news.com'), ['.promo']);
  assert.deepEqual(selectorsForHost(bundle, 'shop.news.com'), []);
});

test('procedural rules are counted but never installed', () => {
  const bundle = emptyBundle();
  compileCosmetic([parseLine('news.com#?#div:has(> .ad)')], bundle);
  assert.equal(bundle.counts.proceduralSkipped, 1);
  assert.deepEqual(selectorsForHost(bundle, 'news.com'), []);
});

/* ----------------------------- compaction ------------------------------ */

import { compactCandidates, compactableDomain, DOMAINS_PER_RULE } from '../src/shared/filter/compact.ts';

function toCandidates(text, source = 'test') {
  return compileList(text, { source }).rules;
}

/** First element, for readable assertions in plain JavaScript. */
const first = (list) => list[0];

test('recognises plain domain rules and nothing else', () => {
  const plain = first(toCandidates('||ads.example.com^'));
  assert.equal(compactableDomain(plain), 'ads.example.com');

  const withPath = first(toCandidates('||ads.example.com/banner^'));
  assert.equal(compactableDomain(withPath), null);

  const wildcard = first(toCandidates('||ads.*.com^'));
  assert.equal(compactableDomain(wildcard), null);

  const partialHost = first(toCandidates('||example.co'));
  assert.equal(compactableDomain(partialHost), null);

  const regex = first(toCandidates('/^https://ads\\./'));
  assert.equal(compactableDomain(regex), null);
});

test('does not compact rules scoped by initiator domains', () => {
  // There the url filter matches the request while the domains match the page,
  // so folding the pattern into requestDomains would change its meaning.
  const rule = first(toCandidates('||ads.example.com^$domain=news.com'));
  assert.equal(compactableDomain(rule), null);
});

test('keeps a lone domain rule as a url filter rather than merging it', () => {
  const { rules } = compactCandidates(toCandidates('||only.example^'));
  assert.equal(rules.length, 1);
  assert.equal(rules[0].condition.urlFilter, '||only.example^');
  assert.equal(rules[0].condition.requestDomains, undefined);
});

test('merges plain domain rules that share the same options', () => {
  const candidates = toCandidates('||a.example^\n||b.example^\n||c.example^');
  const { rules, report } = compactCandidates(candidates);
  assert.equal(rules.length, 1);
  assert.equal(report.sourceRuleCount, 3);
  assert.equal(report.mergedDomains, 3);
  assert.deepEqual(first(rules).condition.requestDomains, ['a.example', 'b.example', 'c.example']);
  assert.equal(first(rules).condition.urlFilter, undefined);
  assert.equal(first(rules).sourceRules, 3);
});

test('keeps rules with different options in separate groups', () => {
  const candidates = toCandidates('||a.example^\n||b.example^$third-party\n||c.example^');
  const { rules } = compactCandidates(candidates);
  assert.equal(rules.length, 2);
  const plain = rules.find((rule) => rule.condition.requestDomains?.length === 2);
  const thirdParty = rules.find((rule) => rule.condition.domainType === 'thirdParty');
  assert.deepEqual(plain.condition.requestDomains, ['a.example', 'c.example']);
  // Only one third-party rule, so it keeps its url filter.
  assert.deepEqual(thirdParty.condition.requestDomains, undefined);
  assert.equal(thirdParty.condition.urlFilter, '||b.example^');
});

test('de-duplicates domains and chunks long lists', () => {
  const lines = [];
  for (let index = 0; index < DOMAINS_PER_RULE + 25; index++) {
    lines.push(`||d${index}.example^`);
  }
  lines.push('||d0.example^'); // duplicate
  const { rules, report } = compactCandidates(toCandidates(lines.join('\n')));
  assert.equal(rules.length, 2);
  assert.equal(first(rules).condition.requestDomains.length, DOMAINS_PER_RULE);
  assert.equal(rules[1].condition.requestDomains.length, 25);
  assert.equal(report.mergedDomains, DOMAINS_PER_RULE + 25);
  // The duplicate line is already dropped by compileList, so 125 source rules
  // remain; compactCandidates de-duplicates domains again as a safeguard.
  assert.equal(report.sourceRuleCount, DOMAINS_PER_RULE + 25);
});

test('compaction keeps the real lists inside Chrome budgets', async () => {
  const fs = await import('node:fs/promises');
  let easylist;
  let easyprivacy;
  try {
    easylist = await fs.readFile('/tmp/qbtest/easylist.txt', 'utf8');
    easyprivacy = await fs.readFile('/tmp/qbtest/easyprivacy.txt', 'utf8');
  } catch {
    // The lists are only present when the developer has downloaded them.
    return;
  }
  const all = [
    ...toCandidates(easylist, 'easylist'),
    ...toCandidates(easyprivacy, 'easyprivacy'),
  ];
  const { rules, report } = compactCandidates(all);
  assert.ok(
    rules.length < 30_000,
    `expected compaction to fit Chrome's dynamic rule limit, got ${rules.length}`,
  );
  assert.ok(report.sourceRuleCount > 100_000, 'expected the full lists to be present');
  // Every distinct source rule must still be represented. The two lists share
  // a handful of identical rules, which collapse into one domain entry.
  const represented = rules.reduce((sum, rule) => sum + rule.sourceRules, 0);
  assert.ok(
    all.length - represented < 50,
    `expected nearly all source rules to survive compaction, lost ${all.length - represented}`,
  );
});

/* --------------------------- starter list ------------------------------ */

test('the built-in starter list compiles to usable rules', () => {
  const compiled = compileList(STARTER_LIST, { source: 'builtin-starter' });
  assert.ok(compiled.rules.length > 50, `expected many rules, got ${compiled.rules.length}`);
  assert.equal(compiled.stats.dropped.duplicate, undefined);
  for (const rule of compiled.rules) {
    assert.equal(rule.action, 'block');
    assert.ok(rule.condition.urlFilter || rule.condition.regexFilter);
    assert.ok(!rule.condition.resourceTypes?.includes('main_frame'));
  }
});

test('parsing a whole list never throws on odd input', () => {
  const lines = parseList('\n\n!\n##\n@@\n||\n$script\n/a/\n###\n');
  assert.ok(lines.every((line) => line.kind === 'ignored' || line.kind === 'network' || line.kind === 'cosmetic'));
});
