/**
 * Compiles the raw text of a filter list into DNR rule candidates plus the
 * cosmetic selectors it contributes.
 *
 * The output is intentionally id-less: ids are assigned when the rules are
 * installed, so the same compiled output can be re-installed after Chrome
 * drops its dynamic rules without re-parsing megabytes of text.
 */

import type { CosmeticEntry, NetworkEntry, ParsedLine } from './parse.ts';
import { parseLine } from './parse.ts';
import { networkEntryToRule, ruleKey, type CandidateRule } from './toDnr.ts';
import type { CosmeticBundle } from './cosmetic.ts';
import { compileCosmetic } from './cosmetic.ts';

export type CompileStats = {
  /** Network rule lines that produced a candidate. */
  networkRules: number;
  /** Cosmetic rule lines, procedural ones included. */
  cosmeticRules: number;
  dropped: Record<string, number>;
};

export type CompileResult = {
  rules: CandidateRule[];
  cosmeticEntries: CosmeticEntry[];
  stats: CompileStats;
};

export function emptyCompileStats(): CompileStats {
  return { networkRules: 0, cosmeticRules: 0, dropped: {} };
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export type CompileOptions = {
  /** Subscription id, recorded on each candidate for budget accounting. */
  source: string;
  /** User rules outrank list rules. */
  isCustom?: boolean;
};

/**
 * Parses and converts `text`. Cosmetic entries are returned unconverted so the
 * caller can merge several lists into one bundle with global caps applied.
 */
export function compileList(text: string, options: CompileOptions): CompileResult {
  const stats = emptyCompileStats();
  const rules: CandidateRule[] = [];
  const cosmeticEntries: CosmeticEntry[] = [];
  const seen = new Set<string>();

  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    let parsed: ParsedLine;
    try {
      parsed = parseLine(lines[index]!);
    } catch {
      bump(stats.dropped, 'parse-error');
      continue;
    }

    if (parsed.kind === 'ignored') continue;

    if (parsed.kind === 'cosmetic') {
      stats.cosmeticRules++;
      cosmeticEntries.push(parsed);
      continue;
    }

    const entry: NetworkEntry = parsed;
    let converted;
    try {
      converted = networkEntryToRule(entry, {
        source: options.source,
        order: index,
        isCustom: options.isCustom ?? false,
      });
    } catch {
      bump(stats.dropped, 'parse-error');
      continue;
    }

    if (!converted.ok) {
      bump(stats.dropped, converted.reason);
      continue;
    }

    const key = ruleKey(converted.rule);
    if (seen.has(key)) {
      bump(stats.dropped, 'duplicate');
      continue;
    }
    seen.add(key);
    rules.push(converted.rule);
    stats.networkRules++;
  }

  return { rules, cosmeticEntries, stats };
}

/** Merges cosmetic entries into `bundle`, respecting the global caps. */
export function mergeCosmetic(
  bundle: CosmeticBundle,
  entries: CosmeticEntry[],
): { dropped: number } {
  return compileCosmetic(entries, bundle);
}
