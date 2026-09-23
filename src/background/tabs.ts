/**
 * Tab bookkeeping: which host each tab is showing, and which tabs have been
 * temporarily exempted from blocking.
 *
 * The temporary exemption is deliberately tab-scoped and stored in
 * chrome.storage.session, which Chrome clears when the browser shuts down. The
 * matching allow rule is a session rule scoped with `tabIds`, so it disappears
 * on its own if the extension ever loses track of the tab.
 */

import { hostFromUrl, isWhitelisted } from '../shared/whitelist.ts';
import { loadSessionState, loadState, saveSessionState } from '../shared/storage.ts';
import type { TabState } from '../shared/types.ts';
import { syncTempAllowRule } from './rules.ts';

const tabHosts = new Map<number, string>();

export function rememberTab(tabId: number, url: string | undefined): void {
  const host = hostFromUrl(url);
  if (host) tabHosts.set(tabId, host);
  else tabHosts.delete(tabId);
}

export function forgetTab(tabId: number): void {
  tabHosts.delete(tabId);
}

export function tabHost(tabId: number): string | null {
  return tabHosts.get(tabId) ?? null;
}

/** Host used to attribute a blocked request to a site. */
export function hostForTab(tabId: number | undefined, initiator: string | undefined): string | null {
  if (tabId !== undefined && tabId >= 0) {
    const known = tabHosts.get(tabId);
    if (known) return known;
  }
  if (initiator) {
    const host = hostFromUrl(initiator.endsWith('/') ? initiator : `${initiator}/`);
    if (host) return host;
  }
  return null;
}

export async function getTabState(tabId: number | undefined): Promise<TabState | null> {
  const state = await loadState();
  const session = await loadSessionState();
  const host = tabId !== undefined ? tabHosts.get(tabId) : undefined;
  if (!host) return null;

  return {
    host,
    enabled: state.settings.enabled,
    whitelisted: isWhitelisted(host, state.whitelist),
    tempAllowed: tabId !== undefined && session.tempAllowTabs[String(tabId)] !== undefined,
  };
}

/** Turns the per-site switch in the popup on or off for one tab. */
export async function setSiteEnabled(tabId: number, enabled: boolean): Promise<void> {
  const session = await loadSessionState();
  const key = String(tabId);
  const host = tabHosts.get(tabId) ?? '';
  if (enabled) {
    delete session.tempAllowTabs[key];
    await syncTempAllowRule(tabId, false);
  } else {
    session.tempAllowTabs[key] = { host };
    await syncTempAllowRule(tabId, true);
  }
  await saveSessionState(session);
}

/** Drops the temporary exemption for a tab that has gone away. */
export async function releaseTempAllow(tabId: number): Promise<void> {
  const session = await loadSessionState();
  const key = String(tabId);
  if (session.tempAllowTabs[key] === undefined) return;
  delete session.tempAllowTabs[key];
  await saveSessionState(session);
  await syncTempAllowRule(tabId, false);
}

/** Re-applies temporary exemptions after a browser restart or an update. */
export async function restoreTempAllows(): Promise<void> {
  const session = await loadSessionState();
  const entries = Object.entries(session.tempAllowTabs);
  for (const [key] of entries) {
    await syncTempAllowRule(Number(key), true);
  }
}
