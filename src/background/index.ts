/**
 * QuietBlock service worker.
 *
 * Responsibilities, and nothing else:
 *   - keep declarativeNetRequest in sync with the enabled filter lists
 *   - keep the whitelist enforced (session-scoped allow rules)
 *   - count blocked requests for the statistics page
 *   - answer the popup and the options page
 *
 * There is no remote configuration fetch, no "what's new" page, no update
 * announcement and no upsell. The only network requests this worker makes are
 * the filter-list downloads the user explicitly configured.
 */

import { EXTENSION_NAME } from '../shared/constants.ts';
import { isWhitelisted, toggleWhitelistEntry } from '../shared/whitelist.ts';
import { loadState, updateState } from '../shared/storage.ts';
import type { RuntimeMessage, StateResponse } from '../shared/types.ts';
import {
  computeSignature,
  installRules,
  readLimits,
  syncCustomSubscription,
  syncWhitelistRules,
} from './rules.ts';
import { addSubscription, maybeAutoUpdate, updateAllLists } from './subscriptions.ts';
import { stats } from './stats.ts';
import {
  forgetTab,
  getTabState,
  hostForTab,
  rememberTab,
  releaseTempAllow,
  resolveTabHost,
  restoreTempAllows,
  setSiteEnabled,
} from './tabs.ts';

/**
 * Runs a start-up task and reports a failure instead of leaving an unhandled
 * rejection. Nothing here notifies the user or opens a tab: the failure is
 * recorded on the affected subscription and surfaced in the UI.
 */
function runSafely(task: () => Promise<unknown>): void {
  task().catch((error: unknown) => {
    console.error('QuietBlock background task failed:', error);
  });
}

/* ------------------------------------------------------------------ *
 * Rule installation, guarded by a signature so the worker does not
 * reinstall tens of thousands of rules on every wake-up.
 * ------------------------------------------------------------------ */

let ensurePromise: Promise<unknown> | null = null;

async function ensureInstalled(force = false): Promise<void> {
  if (ensurePromise && !force) {
    await ensurePromise;
    return;
  }
  const run = (async () => {
    const state = await loadState();
    const signature = computeSignature(state);
    if (!force && state.installSignature === signature) return;
    await installRules();
  })();
  ensurePromise = force ? run : run.catch(() => undefined);
  await run;
}

async function applyChanges(): Promise<void> {
  const state = await loadState();
  await installRules();
  await syncWhitelistRules(state.whitelist);
}

/** Learns the host of every already-open tab after a cold start. */
async function learnOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id !== undefined) rememberTab(tab.id, tab.url);
  }
}

/* ------------------------------------------------------------------ *
 * Badge: a single "!" while a list is failing to update. It is cleared
 * as soon as an update succeeds and never opens anything.
 * ------------------------------------------------------------------ */

async function refreshBadge(): Promise<void> {
  const state = await loadState();
  const failing = state.subscriptions.filter((subscription) => subscription.lastError);
  if (failing.length === 0) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: EXTENSION_NAME });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
  await chrome.action.setBadgeText({ text: '!' });
  await chrome.action.setTitle({
    title: `${EXTENSION_NAME} - ${failing.length} list${failing.length > 1 ? 's' : ''} failed to update`,
  });
}

/* ------------------------------------------------------------------ *
 * State assembly for the UI
 * ------------------------------------------------------------------ */

async function buildState(tabId: number | undefined): Promise<StateResponse> {
  const state = await loadState();
  const recorded = await stats.read();
  const limits = readLimits();
  const subscriptions = state.subscriptions;
  const installed = subscriptions.reduce((sum, subscription) => sum + subscription.dnrRuleCount, 0);
  const patterns = subscriptions.reduce((sum, subscription) => sum + subscription.ruleCount, 0);
  return {
    settings: state.settings,
    subscriptions,
    whitelist: state.whitelist,
    customRules: state.customRules,
    stats: {
      todayTotal: recorded.todayTotal,
      todayBySite: recorded.todayBySite,
      byDay: recorded.byDay,
    },
    tab: await getTabState(tabId),
    installError: state.installError,
    budget: {
      dynamicLimit: limits.dynamicRules,
      installed,
      patterns,
      regexLimit: limits.regexRules,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

async function handleMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  // Content scripts do not know their own tab id, so fall back to the sender.
  const senderTabId = sender.tab?.id;
  switch (message.type) {
    case 'getState':
      return buildState(message.tabId ?? senderTabId);

    case 'setGlobalEnabled': {
      await updateState((draft) => {
        draft.settings.enabled = message.enabled;
      });
      await applyChanges();
      return { ok: true, enabled: message.enabled };
    }

    case 'setSiteEnabled': {
      // The new tab state is returned so the popup can repaint the site card
      // from one round trip instead of asking again.
      await setSiteEnabled(message.tabId, message.enabled);
      return { ok: true, tab: await getTabState(message.tabId) };
    }

    case 'setWhitelisted': {
      const tabId = message.tabId ?? senderTabId;
      const host = (await resolveTabHost(tabId)) ?? undefined;
      if (!host) return { ok: false, error: 'No site to change.' };
      const state = await loadState();
      const allowed = !isWhitelisted(host, state.whitelist);
      await updateState((draft) => {
        draft.whitelist = toggleWhitelistEntry(draft.whitelist, host, allowed);
      });
      if (tabId !== undefined) {
        // Leaving the whitelist also clears a temporary exemption for this tab.
        await setSiteEnabled(tabId, true);
      }
      await applyChanges();
      return { ok: true, host, allowed, tab: await getTabState(tabId) };
    }

    case 'updateLists': {
      const summary = await updateAllLists(true);
      await applyChanges();
      await refreshBadge();
      return { ok: summary.failed.length === 0, summary };
    }

    case 'setSubscriptionEnabled': {
      await updateState((draft) => {
        const target = draft.subscriptions.find((entry) => entry.id === message.id);
        if (target) target.enabled = message.enabled;
      });
      await applyChanges();
      return { ok: true };
    }

    case 'moveSubscription': {
      await updateState((draft) => {
        const index = draft.subscriptions.findIndex((entry) => entry.id === message.id);
        const target = index + message.direction;
        if (index < 0 || target < 0 || target >= draft.subscriptions.length) return;
        const [entry] = draft.subscriptions.splice(index, 1);
        if (entry) draft.subscriptions.splice(target, 0, entry);
      });
      await applyChanges();
      return { ok: true };
    }

    case 'addSubscription': {
      const result = await addSubscription(message.url, message.title);
      if (!result.ok) return { ok: false, error: result.error };
      const state = await loadState();
      await syncWhitelistRules(state.whitelist);
      return { ok: true };
    }

    case 'removeSubscription': {
      await updateState((draft) => {
        draft.subscriptions = draft.subscriptions.filter((entry) => entry.id !== message.id);
      });
      await applyChanges();
      return { ok: true };
    }

    case 'getCustomRules': {
      const state = await loadState();
      return { text: state.customRules };
    }

    case 'setCustomRules':
    case 'importRules': {
      await updateState((draft) => {
        draft.customRules = message.text;
        syncCustomSubscription(draft);
      });
      await applyChanges();
      return { ok: true };
    }

    case 'exportRules': {
      const state = await loadState();
      return { text: state.customRules };
    }

    case 'setStatsEnabled': {
      await updateState((draft) => {
        draft.settings.statsEnabled = message.enabled;
      });
      stats.setEnabled(message.enabled);
      return { ok: true };
    }

    case 'setUpdateInterval': {
      await updateState((draft) => {
        draft.settings.updateIntervalHours = message.hours;
      });
      await configureAlarm();
      return { ok: true };
    }

    case 'clearStats': {
      await stats.clear();
      return { ok: true };
    }

    case 'getTabState':
      return getTabState(message.tabId ?? senderTabId);

    default:
      return { ok: false, error: 'Unknown message' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message as RuntimeMessage, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});

/* ------------------------------------------------------------------ *
 * Alarms
 * ------------------------------------------------------------------ */

async function configureAlarm(): Promise<void> {
  const state = await loadState();
  const hours = state.settings.updateIntervalHours;
  await chrome.alarms.clear('list-update');
  if (hours > 0) {
    const minutes = Math.max(1, Math.round(hours * 60));
    await chrome.alarms.create('list-update', { periodInMinutes: minutes, delayInMinutes: minutes });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'list-update') return;
  runSafely(async () => {
    await maybeAutoUpdate();
    await refreshBadge();
  });
});

/* ------------------------------------------------------------------ *
 * Statistics
 * ------------------------------------------------------------------ */

chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
  const request = info.request;
  // Only requests that belong to a page are counted; extension and service
  // worker traffic has no meaningful site to attribute it to.
  const tabId = request.tabId !== undefined && request.tabId >= 0 ? request.tabId : undefined;
  const host = hostForTab(tabId, request.initiator);
  if (!host || host === chrome.runtime.id) return;
  stats.record(host);
});

/* ------------------------------------------------------------------ *
 * Tab lifecycle
 * ------------------------------------------------------------------ */

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) rememberTab(tabId, changeInfo.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  void releaseTempAllow(tabId);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  const host = hostForTab(removedTabId, undefined);
  forgetTab(removedTabId);
  if (host) rememberTab(addedTabId, `https://${host}/`);
  void releaseTempAllow(removedTabId);
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener((details) => {
  runSafely(async () => {
    await configureAlarm();
    if (details.reason === 'install') {
      // First run: pull EasyList so the extension is useful straight away.
      await updateAllLists(true);
    } else {
      // Dynamic rules survive updates, but the compiled output may have
      // changed, so reinstall from the cached list text.
      await installRules();
    }
    const state = await loadState();
    await syncWhitelistRules(state.whitelist);
    await refreshBadge();
  });
});

chrome.runtime.onStartup.addListener(() => {
  runSafely(async () => {
    await learnOpenTabs();
    await restoreTempAllows();
    const state = await loadState();
    await syncWhitelistRules(state.whitelist);
    await ensureInstalled();
    await maybeAutoUpdate();
    await refreshBadge();
  });
});

chrome.runtime.onSuspend.addListener(() => {
  stats.flush().catch((error: unknown) => console.error('QuietBlock could not flush stats:', error));
});

// Runs on every cold start of the worker. Listeners above are registered
// synchronously first, so nothing that arrives during start-up is missed.
runSafely(async () => {
  const state = await loadState();
  stats.setEnabled(state.settings.statsEnabled);
  await learnOpenTabs();
  await ensureInstalled();
  await refreshBadge();
});
