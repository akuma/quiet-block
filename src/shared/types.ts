/**
 * Shared types for QuietBlock.
 *
 * These types are deliberately free of any `chrome.*` dependency so that the
 * pure filter-compilation modules can be unit tested with plain Node.
 */

/* ------------------------------------------------------------------ *
 * Persisted state (chrome.storage.local)
 * ------------------------------------------------------------------ */

export type Settings = {
  /** Master switch. When false nothing is blocked or hidden. */
  enabled: boolean;
  /** Record blocked-request counts locally. */
  statsEnabled: boolean;
  /** Hours between automatic filter-list updates. 0 = manual only. */
  updateIntervalHours: number;
};

export type SubscriptionKind = 'builtin' | 'remote' | 'custom';

export type Subscription = {
  id: string;
  kind: SubscriptionKind;
  title: string;
  /** Source URL for `remote` subscriptions. */
  url?: string;
  /** Where the list came from, shown in the options page. */
  homepage?: string;
  enabled: boolean;
  /** Epoch ms of the last successful fetch/compile. 0 when never. */
  lastUpdated: number;
  /** Human readable reason of the last failure, if any. */
  lastError?: string;
  /** Number of source rules actually installed into declarativeNetRequest. */
  ruleCount: number;
  /**
   * Number of real declarativeNetRequest rules used. Lower than `ruleCount`
   * because plain `||domain^` rules are merged into rules that carry a domain
   * list.
   */
  dnrRuleCount: number;
  /** Rules that were parsed but not installed (budget or unsupported syntax). */
  droppedCount: number;
  /** Number of cosmetic selectors contributed. */
  cosmeticCount: number;
  /** Inclusive [start, end) range of dynamic rule ids owned by this list. */
  ruleRange?: [number, number];
  /** Hash of the raw text currently compiled, used for cache invalidation. */
  contentHash?: string;
};

export type PersistedState = {
  settings: Settings;
  /** Order matters: earlier lists win when Chrome's rule budget runs out. */
  subscriptions: Subscription[];
  /** Hostnames permanently exempt from blocking and hiding. */
  whitelist: string[];
  /** Raw user filter list, one rule per line, `!` starts a comment. */
  customRules: string;
  /** Monotonic allocator for dynamic rule ids. */
  nextRuleId: number;
  /**
   * Every block of dynamic rule ids this extension has installed, whether or
   * not the subscription that produced it is still in the list. Kept
   * separately from `subscriptions` so that removing a list still removes its
   * rules instead of leaking them.
   */
  installedRanges: Array<[number, number]>;
  /** Signature of the currently installed rule set; null when nothing installed. */
  installSignature: string | null;
  /** Epoch ms of the last automatic update attempt (throttling). */
  lastUpdateAttempt: number;
  /** Set when Chrome refused the last rule batch; cleared on the next success. */
  installError?: string;
};

/* ------------------------------------------------------------------ *
 * Statistics (chrome.storage.local, key "stats.<YYYY-MM-DD>")
 * ------------------------------------------------------------------ */

export type StatsDay = {
  total: number;
  bySite: Record<string, number>;
};

export type StatsSummary = {
  /** Today's global total, including the in-memory buffer. */
  todayTotal: number;
  /** Today's total for a single host, including the in-memory buffer. */
  todayForSite: (host: string) => number;
  /** Last N days, oldest first. */
  days: Array<{ date: string; total: number; top: Array<[string, number]> }>;
};

/* ------------------------------------------------------------------ *
 * Messages (background <-> popup / options / content script)
 * ------------------------------------------------------------------ */

export type RuntimeMessage =
  | { type: 'getState'; tabId?: number }
  | { type: 'setGlobalEnabled'; enabled: boolean }
  | { type: 'setSiteEnabled'; tabId: number; enabled: boolean }
  | { type: 'setWhitelisted'; tabId?: number }
  | { type: 'updateLists' }
  | { type: 'setSubscriptionEnabled'; id: string; enabled: boolean }
  | { type: 'moveSubscription'; id: string; direction: -1 | 1 }
  | { type: 'addSubscription'; url: string; title?: string }
  | { type: 'removeSubscription'; id: string }
  | { type: 'getCustomRules' }
  | { type: 'setCustomRules'; text: string }
  | { type: 'exportRules' }
  | { type: 'importRules'; text: string }
  | { type: 'setStatsEnabled'; enabled: boolean }
  | { type: 'setUpdateInterval'; hours: number }
  | { type: 'clearStats' }
  | { type: 'getTabState'; tabId?: number };

export type TabState = {
  host: string;
  /** Global switch. */
  enabled: boolean;
  /** Host is on the permanent whitelist. */
  whitelisted: boolean;
  /** This tab is temporarily allowed until it closes. */
  tempAllowed: boolean;
};

export type StateResponse = {
  settings: Settings;
  subscriptions: Subscription[];
  whitelist: string[];
  customRules: string;
  stats: {
    todayTotal: number;
    /** Exact per-host counts for today, not just the top N. */
    todayBySite: Record<string, number>;
    byDay: Array<{ date: string; total: number; top: Array<[string, number]> }>;
  };
  tab: TabState | null;
  /** Set when Chrome refused part of the last rule batch. */
  installError?: string;
  /** Rule budget information, surfaced in the options page. */
  budget: {
    dynamicLimit: number;
    /** Real declarativeNetRequest rules in use. */
    installed: number;
    /** Source filter rules those rules stand for. */
    patterns: number;
    regexLimit: number;
  };
};
