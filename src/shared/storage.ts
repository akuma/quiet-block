/**
 * Typed access to chrome.storage.local (persistent, small values) and
 * chrome.storage.session (cleared when the browser shuts down).
 *
 * All mutations of the persisted state go through `updateState`, which
 * serialises read-modify-write cycles so concurrent message handlers cannot
 * clobber each other.
 */

import { DEFAULT_SETTINGS, DEFAULT_SUBSCRIPTIONS, STORAGE_KEYS } from './constants.ts';
import type { PersistedState, Settings } from './types.ts';

export function defaultState(): PersistedState {
  return {
    settings: { ...DEFAULT_SETTINGS },
    subscriptions: DEFAULT_SUBSCRIPTIONS.map((subscription) => ({
      ...subscription,
      lastUpdated: 0,
    })),
    whitelist: [],
    customRules: '',
    nextRuleId: 1,
    installedRanges: [],
    installSignature: null,
    lastUpdateAttempt: 0,
    installError: undefined,
  };
}

/** Fills in anything a state object saved by an older build is missing. */
function migrate(raw: Partial<PersistedState> | undefined): PersistedState {
  const base = defaultState();
  if (!raw) return base;
  const subscriptions =
    Array.isArray(raw.subscriptions) && raw.subscriptions.length > 0
      ? raw.subscriptions
      : base.subscriptions;
  return {
    settings: { ...base.settings, ...(raw.settings ?? {}) },
    subscriptions: subscriptions.map((subscription) => ({
      ...subscription,
      ruleCount: subscription.ruleCount ?? 0,
      droppedCount: subscription.droppedCount ?? 0,
      cosmeticCount: subscription.cosmeticCount ?? 0,
    })),
    whitelist: Array.isArray(raw.whitelist) ? raw.whitelist : [],
    customRules: typeof raw.customRules === 'string' ? raw.customRules : '',
    nextRuleId: typeof raw.nextRuleId === 'number' && raw.nextRuleId > 0 ? raw.nextRuleId : 1,
    installedRanges: Array.isArray(raw.installedRanges)
      ? raw.installedRanges.filter(
          (range): range is [number, number] =>
            Array.isArray(range) &&
            range.length === 2 &&
            typeof range[0] === 'number' &&
            typeof range[1] === 'number',
        )
      : subscriptions
          .map((subscription) => subscription.ruleRange)
          .filter((range): range is [number, number] => Boolean(range)),
    installSignature: typeof raw.installSignature === 'string' ? raw.installSignature : null,
    lastUpdateAttempt: typeof raw.lastUpdateAttempt === 'number' ? raw.lastUpdateAttempt : 0,
    installError: typeof raw.installError === 'string' ? raw.installError : undefined,
  };
}

let stateCache: PersistedState | null = null;
let stateQueue: Promise<unknown> = Promise.resolve();

export async function loadState(): Promise<PersistedState> {
  if (stateCache) return stateCache;
  const stored = await chrome.storage.local.get(STORAGE_KEYS.state);
  stateCache = migrate(stored[STORAGE_KEYS.state] as Partial<PersistedState> | undefined);
  return stateCache;
}

export async function saveState(state: PersistedState): Promise<void> {
  stateCache = state;
  await chrome.storage.local.set({ [STORAGE_KEYS.state]: state });
}

/** Serialised read-modify-write of the persisted state. */
export function updateState<T>(mutate: (state: PersistedState) => T | Promise<T>): Promise<T> {
  const run = stateQueue.then(async () => {
    const state = await loadState();
    const result = await mutate(state);
    await saveState(state);
    return result;
  });
  stateQueue = run.catch(() => undefined);
  return run;
}

/** Drops the in-memory cache; used by tests and after a data reset. */
export function resetStateCache(): void {
  stateCache = null;
}

/* ----------------------------- statistics ------------------------------ */

export function statsKey(date: string): string {
  return `${STORAGE_KEYS.statsPrefix}${date}`;
}

/** Local calendar date as YYYY-MM-DD. */
export function todayKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/* ------------------------- session-scoped state ------------------------ */

export type TempAllowEntry = { host: string };

export type SessionState = {
  /** tabId -> temporarily allowed host, cleared when the tab closes. */
  tempAllowTabs: Record<string, TempAllowEntry>;
};

export const EMPTY_SESSION_STATE: SessionState = { tempAllowTabs: {} };

export async function loadSessionState(): Promise<SessionState> {
  const stored = await chrome.storage.session.get('tempAllowTabs');
  const tabs = stored.tempAllowTabs as Record<string, TempAllowEntry> | undefined;
  return { tempAllowTabs: tabs ?? {} };
}

export async function saveSessionState(state: SessionState): Promise<void> {
  await chrome.storage.session.set({ tempAllowTabs: state.tempAllowTabs });
}

/* ------------------------------ settings ------------------------------- */

export async function getSettings(): Promise<Settings> {
  return (await loadState()).settings;
}
