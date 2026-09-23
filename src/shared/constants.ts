/** Constants shared by the background worker, popup and options page. */

import type { Settings, Subscription } from './types.ts';

export const EXTENSION_NAME = 'QuietBlock';

/** Storage keys inside chrome.storage.local. */
export const STORAGE_KEYS = {
  state: 'state',
  statsPrefix: 'stats.',
} as const;

/** IndexedDB database name and object stores. */
export const IDB = {
  name: 'quietblock',
  version: 1,
  /** keyPath "id" -> { id, text, hash, updatedAt } raw filter-list text. */
  lists: 'lists',
} as const;

/**
 * Rule priority ladder. declarativeNetRequest breaks ties between rules of
 * equal priority by preferring `allow` over `block`, but the documented
 * ordering between rules of the same action type is explicitly unstable, so we
 * never rely on it: every tier gets its own explicit priority.
 *
 * A site on the whitelist always wins, which is what users expect.
 */
export const PRIORITY = {
  listBlock: 1,
  listImportantBlock: 2,
  listAllow: 3,
  customBlock: 4,
  customAllow: 5,
  whitelist: 100,
} as const;

/** Rule ids >= this value are reserved for the background's own bookkeeping. */
export const WHITELIST_RULE_ID_BASE = 1_000_000;
export const TEMP_ALLOW_RULE_ID_BASE = 2_000_000;

/**
 * Chrome's documented ceilings. Read defensively because older Chrome builds
 * do not expose the constants on the API namespace.
 */
export const FALLBACK_LIMITS = {
  dynamicRules: 30_000,
  sessionRules: 5_000,
  regexRules: 1_000,
} as const;

/**
 * Resource types that block rules may target. `main_frame` is deliberately
 * absent: QuietBlock never blocks a top-level document. That keeps a
 * mis-behaving list from blanking a page, and it keeps whitelisting reliable
 * because the document request never depends on a session rule being installed
 * in time.
 */
export const BLOCKABLE_RESOURCE_TYPES = [
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
] as const;

/** Hard caps on compiled cosmetic data so the bundle stays small and fast. */
export const COSMETIC_LIMITS = {
  maxSelectors: 40_000,
  maxDomains: 8_000,
  maxSelectorsPerDomain: 200,
  maxSelectorLength: 400,
} as const;

/** Top-N sites shown per day in the options page. */
export const STATS_TOP_N = 10;

/** How many days of statistics the options page summarises. */
export const STATS_HISTORY_DAYS = 7;

/** Built-in subscriptions. EasyList ships as a default remote subscription. */
export const DEFAULT_SUBSCRIPTIONS: Array<Omit<Subscription, 'lastUpdated'>> = [
  {
    id: 'builtin-starter',
    kind: 'builtin',
    title: 'Starter list (built in)',
    homepage: 'A small, conservative list bundled with the extension.',
    enabled: true,
    ruleCount: 0,
    dnrRuleCount: 0,
    droppedCount: 0,
    cosmeticCount: 0,
  },
  {
    id: 'easylist',
    kind: 'remote',
    title: 'EasyList',
    url: 'https://easylist.to/easylist/easylist.txt',
    homepage: 'https://easylist.to/',
    enabled: true,
    ruleCount: 0,
    dnrRuleCount: 0,
    droppedCount: 0,
    cosmeticCount: 0,
  },
  {
    id: 'easyprivacy',
    kind: 'remote',
    title: 'EasyPrivacy',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    homepage: 'https://easylist.to/',
    enabled: false,
    ruleCount: 0,
    dnrRuleCount: 0,
    droppedCount: 0,
    cosmeticCount: 0,
  },
];

/** Id of the synthetic subscription that carries the user's custom rules. */
export const CUSTOM_SUBSCRIPTION_ID = 'custom';

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  statsEnabled: true,
  updateIntervalHours: 24,
};

/** Host permissions requested up front: only the filter-list hosts we fetch. */
export const LIST_HOST_PERMISSIONS = [
  '*://easylist.to/*',
  '*://*.easylist.to/*',
  '*://easylist-downloads.adblockplus.org/*',
  '*://*.easylist-downloads.adblockplus.org/*',
  '*://secure.fanboy.co.nz/*',
  '*://*.secure.fanboy.co.nz/*',
  '*://raw.githubusercontent.com/*',
];
