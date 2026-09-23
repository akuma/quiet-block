/**
 * Cosmetic filtering content script.
 *
 * Injected at document_start on every http(s) frame. It reads the compiled
 * cosmetic bundle out of IndexedDB and injects one stylesheet, which is enough
 * to hide ads that appear later in the page's life too - CSS keeps applying to
 * nodes added after injection, so no MutationObserver is needed.
 *
 * The script exits immediately, before touching the DOM, when blocking is
 * switched off globally or the site is exempted.
 */

import { isWhitelisted } from '../shared/whitelist.ts';
import { selectorsForHost, selectorsToCss, type CosmeticBundle } from '../shared/filter/cosmetic.ts';
import { loadState } from '../shared/storage.ts';
import { getCosmeticRecord } from '../shared/idb.ts';
import type { TabState } from '../shared/types.ts';

/** Reads the cosmetic bundle out of chrome.storage.local. */
async function readBundle(): Promise<CosmeticBundle | null> {
  try {
    const record = await getCosmeticRecord();
    return (record?.bundle as CosmeticBundle | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Asks the worker whether this particular tab is exempted. */
async function readTabState(): Promise<TabState | null> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'getTabState' })) as
      | TabState
      | { ok: false; error: string }
      | undefined;
    if (!response || 'error' in response) return null;
    return response;
  } catch {
    // The worker may be unavailable; assume the tab is not exempted rather
    // than silently disabling hiding.
    return null;
  }
}

function injectStylesheet(css: string): void {
  if (!css) return;
  const style = document.createElement('style');
  style.id = 'quietblock-cosmetic';
  style.textContent = css;
  // document_start may run before <head> exists; <html> always does, and a
  // <style> element is honoured there.
  const parent = document.head ?? document.documentElement;
  if (!parent) return;
  parent.appendChild(style);
}

async function main(): Promise<void> {
  const host = location.hostname;
  if (!host) return;

  const state = await loadState();
  if (!state.settings.enabled) return;
  if (isWhitelisted(host, state.whitelist)) return;

  const tabState = await readTabState();
  if (tabState && (tabState.tempAllowed || tabState.whitelisted || !tabState.enabled)) return;

  const bundle = await readBundle();
  if (!bundle) return;

  injectStylesheet(selectorsToCss(selectorsForHost(bundle, host)));
}

void main();
