/**
 * Fetching and updating filter-list subscriptions.
 *
 * Raw list text is kept in IndexedDB and only ever re-parsed when its hash
 * changes. Failures are recorded on the subscription itself and surfaced in the
 * popup and options page - nothing is retried in a loop and nothing is shown
 * as a notification or a new tab.
 */

import { hashText, putListRecord } from '../shared/idb.ts';
import { loadState, updateState } from '../shared/storage.ts';
import { normalizeSubscriptionUrl } from '../shared/whitelist.ts';
import type { Subscription } from '../shared/types.ts';
import { invalidateCompiledCache, installRules } from './rules.ts';

const FETCH_TIMEOUT_MS = 30_000;

export type UpdateFailure = { id: string; title: string; error: string };

export type UpdateSummary = {
  updated: string[];
  failed: UpdateFailure[];
  skipped: string[];
};

function describeFetchError(url: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return `Could not reach ${url}. Check the connection, or grant QuietBlock access to this host in the options page.`;
  }
  return message;
}

export async function fetchListText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    const text = await response.text();
    if (text.length === 0) throw new Error('The list is empty');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Downloads one subscription and stores its text. Never throws. */
export async function updateSubscription(subscription: Subscription): Promise<UpdateSummary> {
  if (subscription.kind !== 'remote' || !subscription.url) {
    return { updated: [], failed: [], skipped: [subscription.id] };
  }
  try {
    const text = await fetchListText(subscription.url);
    await putListRecord({
      id: subscription.id,
      text,
      hash: hashText(text),
      updatedAt: Date.now(),
    });
    await updateState((draft) => {
      const target = draft.subscriptions.find((entry) => entry.id === subscription.id);
      if (target) {
        target.lastUpdated = Date.now();
        target.lastError = undefined;
      }
    });
    invalidateCompiledCache();
    return { updated: [subscription.id], failed: [], skipped: [] };
  } catch (error) {
    const message = describeFetchError(subscription.url, error);
    await updateState((draft) => {
      const target = draft.subscriptions.find((entry) => entry.id === subscription.id);
      if (target) target.lastError = message;
    });
    return { updated: [], failed: [{ id: subscription.id, title: subscription.title, error: message }], skipped: [] };
  }
}

/**
 * Updates every enabled remote subscription. Without `force`, a list that was
 * already fetched within the last hour is left alone, so an alarm firing early
 * or two triggers in quick succession cannot turn into repeated downloads.
 */
export async function updateAllLists(force = false): Promise<UpdateSummary> {
  const state = await loadState();
  const summary: UpdateSummary = { updated: [], failed: [], skipped: [] };
  const now = Date.now();

  for (const subscription of state.subscriptions) {
    if (!subscription.enabled || subscription.kind !== 'remote') {
      summary.skipped.push(subscription.id);
      continue;
    }
    if (!force && subscription.lastUpdated > 0 && now - subscription.lastUpdated < 3_600_000) {
      summary.skipped.push(subscription.id);
      continue;
    }
    const result = await updateSubscription(subscription);
    summary.updated.push(...result.updated);
    summary.failed.push(...result.failed);
  }

  await updateState((draft) => {
    draft.lastUpdateAttempt = Date.now();
  });
  await installRules();
  return summary;
}

/**
 * Called on the alarm. Throttled to at most one automatic pass per configured
 * interval so a flaky network cannot turn into a retry loop.
 */
export async function maybeAutoUpdate(): Promise<UpdateSummary | null> {
  const state = await loadState();
  if (state.settings.updateIntervalHours <= 0) return null;
  const due =
    state.lastUpdateAttempt === 0 ||
    Date.now() >= state.lastUpdateAttempt + state.settings.updateIntervalHours * 3_600_000;
  if (!due) return null;
  return updateAllLists(true);
}

export type AddSubscriptionResult =
  | { ok: true; subscription: Subscription }
  | { ok: false; error: string };

/** Adds a remote subscription after normalising its URL. */
export async function addSubscription(
  input: string,
  title?: string,
): Promise<AddSubscriptionResult> {
  const url = normalizeSubscriptionUrl(input);
  if (!url) {
    return { ok: false, error: 'That does not look like a valid list URL.' };
  }
  const existing = await loadState();
  if (existing.subscriptions.some((subscription) => subscription.url === url)) {
    return { ok: false, error: 'That list is already in your subscriptions.' };
  }

  const id = `remote-${hashUrl(url)}`;
  const subscription: Subscription = {
    id,
    kind: 'remote',
    title: title?.trim() || hostOf(url),
    url,
    homepage: new URL(url).origin,
    enabled: true,
    lastUpdated: 0,
    ruleCount: 0,
    dnrRuleCount: 0,
    droppedCount: 0,
    cosmeticCount: 0,
  };

  const result = await updateSubscription(subscription);
  if (result.failed.length > 0) {
    return { ok: false, error: result.failed[0]!.error };
  }

  await updateState((draft) => {
    draft.subscriptions.push(subscription);
  });
  await installRules();
  return { ok: true, subscription };
}

function hashUrl(url: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < url.length; index++) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
