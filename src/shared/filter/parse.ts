/**
 * Adblock-style filter-list line parser.
 *
 * Pure functions, no Chrome APIs, no DOM: this module is unit tested directly
 * with `node --test` (see tests/filter.test.mjs).
 *
 * Supported syntax (the stable subset that maps onto declarativeNetRequest):
 *
 *   ! comment
 *   [Adblock Plus 2.0]                 header
 *   ||example.com^                     network blocking pattern
 *   /regexp/                           network regex pattern
 *   @@||example.com^$image             network exception
 *   ##.ad                              generic cosmetic hide
 *   #@#.ad                             generic cosmetic exception
 *   example.com##.ad                   site-specific cosmetic hide
 *   example.com#@#.ad                  site-specific cosmetic exception
 *   #?#selector                        procedural cosmetic - recognised, skipped
 *   #@?#selector                       procedural cosmetic exception - skipped
 *
 * Options understood: third-party, ~third-party, domain=, important,
 * ~important, match-case, resource types (script, image, ...), ~resource type,
 * all. Anything else marks the rule unsupported and it is not installed.
 */

export type ResourceTypeName =
  | 'script'
  | 'image'
  | 'stylesheet'
  | 'object'
  | 'xmlhttprequest'
  | 'subdocument'
  | 'document'
  | 'ping'
  | 'font'
  | 'media'
  | 'websocket'
  | 'other'
  | 'csp'
  | 'all';

export type NetworkOptions = {
  /** true = third-party only, false = first-party only, undefined = either. */
  thirdParty?: boolean;
  important?: boolean;
  matchCase?: boolean;
  /** Included resource types; empty means "any". */
  types: ResourceTypeName[];
  /** Excluded resource types. */
  excludedTypes: ResourceTypeName[];
  /** `domain=` include list, without the `~` entries. */
  domains: string[];
  /** `domain=` exclude list, entries that started with `~`. */
  excludedDomains: string[];
  /** Option names QuietBlock does not implement. */
  unsupported: string[];
};

export type NetworkEntry = {
  kind: 'network';
  /** Pattern with the surrounding `/` removed for regex rules. */
  pattern: string;
  isRegex: boolean;
  /** `@@` rules allow the request instead of blocking it. */
  exception: boolean;
  options: NetworkOptions;
};

export type CosmeticEntry = {
  kind: 'cosmetic';
  selector: string;
  /** null = applies everywhere, otherwise the `domain=` list. */
  domains: string[] | null;
  /** Domains prefixed with `~`. */
  excludedDomains: string[];
  /** `#@#` / `#@?#` variants un-hide instead of hide. */
  exception: boolean;
  /** `#?#` / `#@?#` procedural rules: parsed, reported, never installed. */
  procedural: boolean;
};

export type ParsedLine = NetworkEntry | CosmeticEntry | { kind: 'ignored' };

const IGNORED: ParsedLine = { kind: 'ignored' };

/** Longest-first so that `#@?#` is matched before `#?#` could mis-split. */
const COSMETIC_SEPARATORS = ['#@?#', '#?#', '#@#', '##'] as const;

/** Resource-type option names, mapped to the canonical name used internally. */
const RESOURCE_TYPE_OPTIONS = new Set<string>([
  'script',
  'image',
  'stylesheet',
  'object',
  'xmlhttprequest',
  'subdocument',
  'document',
  'ping',
  'font',
  'media',
  'websocket',
  'other',
  'csp',
  'all',
]);

/** Options QuietBlock understands; everything else is reported as unsupported. */
const KNOWN_OPTIONS = new Set<string>([
  'third-party',
  'important',
  'match-case',
  'domain',
  ...RESOURCE_TYPE_OPTIONS,
]);

const MAX_PATTERN_LENGTH = 4096;
const MAX_SELECTOR_LENGTH = 400;

function emptyOptions(): NetworkOptions {
  return {
    types: [],
    excludedTypes: [],
    domains: [],
    excludedDomains: [],
    unsupported: [],
  };
}

/**
 * Finds the first cosmetic separator in a line. Cosmetic separators are
 * checked before `$` splitting because selectors legitimately contain `$`
 * (for example `##a[href$=".png"]`).
 */
function findCosmeticSeparator(line: string): { index: number; separator: string } | null {
  let best: { index: number; separator: string } | null = null;
  for (const separator of COSMETIC_SEPARATORS) {
    const index = line.indexOf(separator);
    if (index < 0) continue;
    if (
      best === null ||
      index < best.index ||
      (index === best.index && separator.length > best.separator.length)
    ) {
      best = { index, separator };
    }
  }
  return best;
}

/** Splits an adblock `domain=` value into included and excluded hosts. */
export function parseDomainList(value: string): { domains: string[]; excluded: string[] } {
  const domains: string[] = [];
  const excluded: string[] = [];
  for (const raw of value.split('|')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('~')) {
      const host = entry.slice(1);
      if (host) excluded.push(host);
    } else {
      domains.push(entry);
    }
  }
  return { domains, excluded };
}

/**
 * Light validation of a cosmetic selector. A malformed selector is dropped
 * rather than risk swallowing the rest of the injected stylesheet: each
 * selector is emitted as its own CSS rule, but an unterminated string or a
 * stray `}` would still break everything after it.
 */
export function isValidSelector(selector: string): boolean {
  if (!selector) return false;
  if (selector.length > MAX_SELECTOR_LENGTH) return false;
  if (/[\n\r{}]/.test(selector)) return false;
  if (selector.includes('/*')) return false;
  // Reject unbalanced brackets/parens/quotes, the usual copy-paste breakage.
  for (const [open, close] of [
    ['[', ']'],
    ['(', ')'],
  ] as const) {
    let depth = 0;
    for (const ch of selector) {
      if (ch === open) depth++;
      else if (ch === close) depth--;
      if (depth < 0) return false;
    }
    if (depth !== 0) return false;
  }
  const quotes = (selector.match(/["']/g) ?? []).length;
  if (quotes % 2 !== 0) return false;
  return true;
}

function parseOptions(raw: string): NetworkOptions {
  const options = emptyOptions();
  if (!raw) return options;
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const negated = token.startsWith('~');
    const body = negated ? token.slice(1) : token;
    const eq = body.indexOf('=');
    const name = (eq < 0 ? body : body.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? '' : body.slice(eq + 1).trim();

    if (name === 'third-party') {
      options.thirdParty = !negated;
    } else if (name === 'important') {
      options.important = !negated;
    } else if (name === 'match-case') {
      options.matchCase = !negated;
    } else if (name === 'domain') {
      const { domains, excluded } = parseDomainList(value);
      if (negated) {
        options.excludedDomains.push(...domains, ...excluded);
      } else {
        options.domains.push(...domains);
        options.excludedDomains.push(...excluded);
      }
    } else if (RESOURCE_TYPE_OPTIONS.has(name)) {
      const target = negated ? options.excludedTypes : options.types;
      target.push(name as ResourceTypeName);
    } else if (!KNOWN_OPTIONS.has(name)) {
      options.unsupported.push(name);
    }
  }
  return options;
}

/** Parses one filter-list line. Never throws. */
export function parseLine(raw: string): ParsedLine {
  const line = raw.trim();
  if (!line) return IGNORED;
  if (line.startsWith('!')) return IGNORED;
  if (line.startsWith('[') && line.endsWith(']')) return IGNORED;

  const cosmetic = findCosmeticSeparator(line);
  if (cosmetic) {
    const domainPart = line.slice(0, cosmetic.index).trim();
    const selector = line.slice(cosmetic.index + cosmetic.separator.length).trim();
    if (!isValidSelector(selector)) return IGNORED;
    const { domains, excluded } = parseDomainList(domainPart);
    return {
      kind: 'cosmetic',
      selector,
      domains: domains.length > 0 ? domains : null,
      excludedDomains: excluded,
      exception: cosmetic.separator.includes('@'),
      procedural: cosmetic.separator.includes('?'),
    };
  }

  let rest = line;
  let exception = false;
  if (rest.startsWith('@@')) {
    exception = true;
    rest = rest.slice(2);
  }

  // The first `$` separates pattern from options. Patterns containing a literal
  // `$` are rare and get mis-split; they are dropped by the caller's checks.
  const dollar = rest.indexOf('$');
  const pattern = (dollar < 0 ? rest : rest.slice(0, dollar)).trim();
  if (!pattern) return IGNORED;
  if (pattern.length > MAX_PATTERN_LENGTH) return IGNORED;

  const isRegex = pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/');
  return {
    kind: 'network',
    pattern: isRegex ? pattern.slice(1, -1) : pattern,
    isRegex,
    exception,
    options: parseOptions(dollar < 0 ? '' : rest.slice(dollar + 1)),
  };
}

/** Convenience for tests and the import dialog. */
export function parseList(text: string): ParsedLine[] {
  return text.split('\n').map(parseLine);
}
