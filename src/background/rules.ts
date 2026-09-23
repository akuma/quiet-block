/**
 * Installs compiled filter rules into declarativeNetRequest and keeps the
 * whitelist enforced there.
 *
 * Two separate mechanisms are used on purpose:
 *
 *   - Blocking rules are *dynamic* rules. They survive browser restarts and
 *     extension updates, so the service worker does not have to reinstall
 *     30,000 rules every time it wakes up.
 *   - Whitelisting uses *session* rules. Session rules are the only scope that
 *     supports `tabIds`, which is what "allow this tab until it closes" needs,
 *     and Chrome drops them when the browser shuts down - exactly the lifetime
 *     a temporary exemption should have.
 *
 * Rule ids are allocated in contiguous blocks per subscription so a list can be
 * re-compiled or disabled by removing just its own range.
 */

import {
  CUSTOM_SUBSCRIPTION_ID,
  FALLBACK_LIMITS,
  PRIORITY,
  TEMP_ALLOW_RULE_ID_BASE,
  WHITELIST_RULE_ID_BASE,
} from '../shared/constants.ts';
import { STARTER_LIST } from '../shared/filter/starterList.ts';
import { compileList } from '../shared/filter/compile.ts';
import { compactCandidates, type CompactedRule } from '../shared/filter/compact.ts';
import { compileCosmetic, emptyBundle, type CosmeticBundle } from '../shared/filter/cosmetic.ts';
import { getListRecord, hashText, putCosmeticRecord } from '../shared/idb.ts';
import { loadState, updateState } from '../shared/storage.ts';
import type { PersistedState, Subscription } from '../shared/types.ts';

export type Limits = {
  dynamicRules: number;
  sessionRules: number;
  regexRules: number;
};

export function readLimits(): Limits {
  const api = chrome.declarativeNetRequest as unknown as Record<string, number | undefined>;
  return {
    dynamicRules: Math.min(
      api.MAX_NUMBER_OF_DYNAMIC_RULES ?? FALLBACK_LIMITS.dynamicRules,
      FALLBACK_LIMITS.dynamicRules,
    ),
    sessionRules: Math.min(
      api.MAX_NUMBER_OF_SESSION_RULES ?? FALLBACK_LIMITS.sessionRules,
      FALLBACK_LIMITS.sessionRules,
    ),
    regexRules: Math.min(
      api.MAX_NUMBER_OF_REGEX_RULES ?? FALLBACK_LIMITS.regexRules,
      FALLBACK_LIMITS.regexRules,
    ),
  };
}

export type CompiledList = ReturnType<typeof compileList>;

/** Small cache keyed by content hash: avoids re-parsing megabytes on reorder. */
const compiledCache = new Map<string, CompiledList>();
const COMPILED_CACHE_SIZE = 4;

function cacheCompiled(hash: string, compiled: CompiledList): CompiledList {
  compiledCache.set(hash, compiled);
  while (compiledCache.size > COMPILED_CACHE_SIZE) {
    const oldest = compiledCache.keys().next().value;
    if (oldest === undefined) break;
    compiledCache.delete(oldest);
  }
  return compiled;
}

/** Drops every cached compile; called when raw list text changes. */
export function invalidateCompiledCache(): void {
  compiledCache.clear();
}

/** The raw filter text for a subscription, or null when it must be fetched. */
export async function getSubscriptionText(
  subscription: Subscription,
  state: PersistedState,
): Promise<{ text: string; hash: string } | null> {
  if (subscription.kind === 'builtin') {
    return { text: STARTER_LIST, hash: hashText(STARTER_LIST) };
  }
  if (subscription.kind === 'custom') {
    if (!state.customRules.trim()) return null;
    return { text: state.customRules, hash: hashText(state.customRules) };
  }
  const record = await getListRecord(subscription.id);
  if (!record) return null;
  return { text: record.text, hash: record.hash };
}

async function compileSubscription(
  subscription: Subscription,
  state: PersistedState,
): Promise<{ compiled: CompiledList; hash: string } | null> {
  const source = await getSubscriptionText(subscription, state);
  if (!source) return null;
  const compiled =
    compiledCache.get(source.hash) ??
    cacheCompiled(
      source.hash,
      compileList(source.text, {
        source: subscription.id,
        isCustom: subscription.kind === 'custom',
      }),
    );
  return { compiled, hash: source.hash };
}

/**
 * Keeps the synthetic "custom rules" subscription in step with the text the
 * user typed. The rules live in their own field, but presenting them as an
 * ordinary subscription means the installer, the rule-id allocator and the
 * options page all treat them the same way as any other list - which is how
 * their rule range ends up persisted and can be removed again.
 */
export function syncCustomSubscription(state: PersistedState): void {
  const hasRules = state.customRules.trim().length > 0;
  const existing = state.subscriptions.find((entry) => entry.id === CUSTOM_SUBSCRIPTION_ID);
  if (hasRules && !existing) {
    state.subscriptions.push({
      id: CUSTOM_SUBSCRIPTION_ID,
      kind: 'custom',
      title: 'Your custom rules',
      enabled: true,
      lastUpdated: 0,
      ruleCount: 0,
      dnrRuleCount: 0,
      droppedCount: 0,
      cosmeticCount: 0,
    });
  } else if (!hasRules && existing) {
    state.subscriptions = state.subscriptions.filter((entry) => entry.id !== CUSTOM_SUBSCRIPTION_ID);
  }
}

/**
 * Hash input for the signature, without reading any list text.
 *
 * This runs on every cold start of the service worker, which is exactly when
 * the popup's first message arrives. Reading a 2 MB filter list out of
 * IndexedDB just to learn its hash made opening the popup feel sluggish, so
 * the hash recorded when the list was last compiled is used instead.
 *
 * That stays correct: `installRules` only records a hash for a subscription
 * whose text it actually found, so a list whose text has vanished reports
 * `missing` and the signature changes, which forces a reinstall attempt.
 */
function subscriptionHash(subscription: Subscription, state: PersistedState): string {
  if (subscription.kind === 'builtin') return hashText(STARTER_LIST);
  if (subscription.kind === 'custom') {
    return state.customRules.trim() ? hashText(state.customRules) : 'missing';
  }
  return subscription.contentHash ?? 'missing';
}

/** Signature of everything that influences the installed rule set. */
export function computeSignature(state: PersistedState): string {
  const parts: string[] = [`enabled=${state.settings.enabled ? 1 : 0}`];
  for (const subscription of state.subscriptions) {
    if (!subscription.enabled) continue;
    parts.push(`${subscription.id}:${subscriptionHash(subscription, state)}`);
  }
  return parts.join('|');
}

function cosmeticTotal(bundle: CosmeticBundle): number {
  return (
    bundle.generic.length +
    bundle.genericAllow.length +
    Object.values(bundle.specific).reduce((sum, list) => sum + list.length, 0) +
    Object.values(bundle.specificAllow).reduce((sum, list) => sum + list.length, 0)
  );
}

export type InstallReport = {
  installed: number;
  removed: number;
  /** Candidates dropped because of Chrome's limits. */
  droppedByBudget: number;
  droppedBySubscription: Record<string, number>;
  cosmeticSelectors: number;
  signature: string;
};

/**
 * Compiles every enabled subscription, enforces Chrome's rule budget and
 * installs the result as dynamic rules. Rebuilds the cosmetic bundle in
 * IndexedDB at the same time so the content script picks up the new selectors.
 */
/**
 * Serialises rule installation.
 *
 * `chrome.runtime.onInstalled` and the worker's own start-up code both trigger
 * an install, and a list update re-installs afterwards. Without this lock two
 * installs interleave: both read the same starting state, both allocate the
 * same rule ids, and whichever finishes last overwrites the signature with a
 * stale one - which is how a successfully downloaded list ends up installed as
 * zero rules.
 */
let installQueue: Promise<unknown> = Promise.resolve();

/** Queued entry point used by everything that changes the installed rules. */
export function installRules(): Promise<InstallReport> {
  const run = installQueue.then(() => installRulesUnserialised());
  installQueue = run.catch(() => undefined);
  return run;
}

/**
 * Adds rules to declarativeNetRequest, dropping only the individual rules
 * Chrome refuses instead of failing the whole batch.
 *
 * Chrome rejects an oversized batch atomically, and a single rule whose
 * compiled regex is too large makes it reject everything. Splitting on failure
 * and recursing finds the offender: at worst this costs a handful of extra
 * calls, and it guarantees that one bad line in a filter list cannot leave the
 * extension with no rules at all.
 */
async function addRulesSafely(rules: chrome.declarativeNetRequest.Rule[]): Promise<number> {
  if (rules.length === 0) return 0;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
    return rules.length;
  } catch (error) {
    if (rules.length === 1) {
      // Nothing left to narrow down: this rule is the problem.
      console.warn(`QuietBlock dropped an unusable rule: ${describeError(error)}`, rules[0]);
      return 0;
    }
    const middle = Math.floor(rules.length / 2);
    const left = await addRulesSafely(rules.slice(0, middle));
    const right = await addRulesSafely(rules.slice(middle));
    return left + right;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function installRulesUnserialised(): Promise<InstallReport> {
  const state = await loadState();
  syncCustomSubscription(state);
  const limits = readLimits();

  if (!state.settings.enabled) {
    await removeAllRules(state);
    const signature = computeSignature(state);
    await updateState((draft) => {
      draft.installSignature = signature;
      for (const subscription of draft.subscriptions) {
        subscription.ruleCount = 0;
        subscription.dnrRuleCount = 0;
        subscription.ruleRange = undefined;
        subscription.droppedCount = 0;
      }
      draft.installedRanges = [];
    });
    return {
      installed: 0,
      removed: 0,
      droppedByBudget: 0,
      droppedBySubscription: {},
      cosmeticSelectors: 0,
      signature,
    };
  }

  // Ordered candidates. Each subscription is compacted first, which folds its
  // plain `||domain^` rules into a few rules carrying domain lists. Budget
  // enforcement then happens on the compacted rules, so a list is only ever
  // truncated when it genuinely does not fit.
  const ordered: CompactedRule[] = [];
  const perSubscriptionTotals = new Map<string, number>();
  const compiledBySubscription = new Map<string, CompiledList>();
  const contentHashes = new Map<string, string>();
  for (const subscription of state.subscriptions) {
    if (!subscription.enabled) continue;
    const compiled = await compileSubscription(subscription, state);
    if (!compiled) continue;
    compiledBySubscription.set(subscription.id, compiled.compiled);
    contentHashes.set(subscription.id, compiled.hash);
    perSubscriptionTotals.set(subscription.id, compiled.compiled.rules.length);
    const sorted = [...compiled.compiled.rules].sort(
      (a, b) => a.tier - b.tier || a.order - b.order,
    );
    ordered.push(...compactCandidates(sorted).rules);
  }

  // Budget enforcement. Chrome rejects the entire batch when it is too large,
  // so truncation has to happen here rather than letting the API complain.
  const kept: CompactedRule[] = [];
  let regexCount = 0;
  for (const rule of ordered) {
    if (kept.length >= limits.dynamicRules) break;
    if (rule.condition.regexFilter !== undefined) {
      if (regexCount >= limits.regexRules) continue;
      regexCount++;
    }
    kept.push(rule);
  }
  const droppedByBudget = ordered.length - kept.length;

  const keptBySubscription = new Map<string, CompactedRule[]>();
  for (const rule of kept) {
    const bucket = keptBySubscription.get(rule.source);
    if (bucket) bucket.push(rule);
    else keptBySubscription.set(rule.source, [rule]);
  }

  // Contiguous id blocks, one per subscription that contributed rules.
  let nextId = state.nextRuleId;
  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  const newRanges = new Map<string, [number, number]>();
  for (const [subscriptionId, rules] of keptBySubscription) {
    const start = nextId;
    for (const rule of rules) {
      addRules.push({
        id: nextId++,
        priority: rule.priority,
        action: { type: rule.action },
        condition: rule.condition,
      });
    }
    newRanges.set(subscriptionId, [start, nextId]);
  }

  const removeRuleIds: number[] = [];
  for (const [start, end] of state.installedRanges) {
    for (let id = start; id < end; id++) removeRuleIds.push(id);
  }

  if (addRules.length > 0 || removeRuleIds.length > 0) {
    try {
      if (removeRuleIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
      }
      const installedCount = await addRulesSafely(addRules);
      if (installedCount !== addRules.length) {
        await updateState((draft) => {
          draft.installError =
            `${addRules.length - installedCount} of ${addRules.length} rules were refused by ` +
            `Chrome and skipped. Check the service worker console for details.`;
        });
      }
    } catch (error) {
      await updateState((draft) => {
        draft.installError = `Chrome refused the rule batch: ${describeError(error)}`;
      });
      throw error;
    }
  }

  // Cosmetic bundle, rebuilt from the same compiled data.
  const bundle = emptyBundle();
  const cosmeticCounts = new Map<string, number>();
  for (const [subscriptionId, compiled] of compiledBySubscription) {
    const before = cosmeticTotal(bundle);
    compileCosmetic(compiled.cosmeticEntries, bundle);
    cosmeticCounts.set(subscriptionId, cosmeticTotal(bundle) - before);
  }
  await putCosmeticRecord(bundle.version, bundle);

  const signature = computeSignature(state);
  // Source rules that made it into the installed set, and those the budget
  // cut. A merged rule stands for as many source rules as it has domains.
  const installedSources = new Map<string, number>();
  for (const [subscriptionId, rules] of keptBySubscription) {
    installedSources.set(
      subscriptionId,
      rules.reduce((sum, rule) => sum + rule.sourceRules, 0),
    );
  }
  const droppedBySubscription: Record<string, number> = {};
  for (const [subscriptionId, total] of perSubscriptionTotals) {
    const dropped = total - (installedSources.get(subscriptionId) ?? 0);
    if (dropped > 0) droppedBySubscription[subscriptionId] = dropped;
  }

  await updateState((draft) => {
    draft.nextRuleId = nextId;
    draft.installSignature = signature;
    draft.installError = undefined;
    draft.installedRanges = [...newRanges.values()];
    for (const subscription of draft.subscriptions) {
      const range = newRanges.get(subscription.id);
      subscription.ruleRange = range;
      subscription.dnrRuleCount = range ? range[1] - range[0] : 0;
      subscription.ruleCount = installedSources.get(subscription.id) ?? 0;
      subscription.droppedCount = droppedBySubscription[subscription.id] ?? 0;
      subscription.cosmeticCount = cosmeticCounts.get(subscription.id) ?? 0;
      // Only recorded when the text was actually found, so a vanished list
      // shows up as a signature change rather than a silent no-op.
      subscription.contentHash = contentHashes.get(subscription.id);
    }
  });

  return {
    installed: addRules.length,
    removed: removeRuleIds.length,
    droppedByBudget,
    droppedBySubscription,
    cosmeticSelectors: cosmeticTotal(bundle),
    signature,
  };
}

async function removeAllRules(state: PersistedState): Promise<void> {
  const removeRuleIds: number[] = [];
  for (const [start, end] of state.installedRanges) {
    for (let id = start; id < end; id++) removeRuleIds.push(id);
  }
  if (removeRuleIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  }
}

/* ------------------------------------------------------------------ *
 * Whitelist rules (session scope)
 * ------------------------------------------------------------------ */

/**
 * Two allow rules per whitelisted host: one matching requests *to* the host
 * (first-party resources a list might have caught) and one matching requests
 * *initiated by* the host (everything the page pulls in). declarativeNetRequest
 * ANDs condition properties together, so a single rule cannot express "or".
 *
 * Ids are `1_000_000 + index * 2` and `+1`, capped at 1000 hosts so the block
 * stays below TEMP_ALLOW_RULE_ID_BASE.
 */
export async function syncWhitelistRules(whitelist: readonly string[]): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = existing
    .filter((rule) => rule.id >= WHITELIST_RULE_ID_BASE && rule.id < TEMP_ALLOW_RULE_ID_BASE)
    .map((rule) => rule.id);

  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  whitelist.slice(0, 1000).forEach((host, index) => {
    const base = WHITELIST_RULE_ID_BASE + index * 2;
    addRules.push({
      id: base,
      priority: PRIORITY.whitelist,
      action: { type: 'allow' },
      condition: { requestDomains: [host], resourceTypes: ['main_frame'] },
    });
    addRules.push({
      id: base + 1,
      priority: PRIORITY.whitelist,
      action: { type: 'allow' },
      condition: { initiatorDomains: [host] },
    });
  });

  await chrome.declarativeNetRequest.updateSessionRules({ addRules, removeRuleIds });
}

/** Adds or removes the per-tab allow rule used by "pause on this site". */
export async function syncTempAllowRule(tabId: number, allowed: boolean): Promise<number> {
  const id = TEMP_ALLOW_RULE_ID_BASE + tabId;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: allowed
      ? [
          {
            id,
            priority: PRIORITY.whitelist,
            action: { type: 'allow' },
            // tabIds is only valid on session-scoped rules.
            condition: { tabIds: [tabId] },
          },
        ]
      : [],
  });
  return id;
}
