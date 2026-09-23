/**
 * Popup controller.
 *
 * Everything shown here is read from the background worker with a single
 * message; the popup holds no state of its own beyond what is on screen.
 */

import type { StateResponse } from '../shared/types.ts';

type Response<T> = T | { ok: false; error: string };

function isError<T>(value: Response<T>): value is { ok: false; error: string } {
  return typeof value === 'object' && value !== null && 'error' in value && 'ok' in value;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const elements = {
  globalToggle: byId<HTMLInputElement>('global-toggle'),
  siteCard: byId<HTMLElement>('site-card'),
  siteHost: byId<HTMLElement>('site-host'),
  siteToggle: byId<HTMLInputElement>('site-toggle'),
  siteHint: byId<HTMLElement>('site-hint'),
  whitelistButton: byId<HTMLButtonElement>('whitelist-button'),
  todaySite: byId<HTMLElement>('today-site'),
  todayTotal: byId<HTMLElement>('today-total'),
  listStatus: byId<HTMLElement>('list-status'),
  updateButton: byId<HTMLButtonElement>('update-button'),
  optionsButton: byId<HTMLButtonElement>('options-button'),
  status: byId<HTMLElement>('status'),
};

let currentTabId: number | undefined;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function showStatus(message: string, isError = false, sticky = false): void {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
  elements.status.hidden = false;
  if (statusTimer !== null) clearTimeout(statusTimer);
  if (!sticky) {
    statusTimer = setTimeout(() => {
      elements.status.hidden = true;
    }, 6000);
  }
}

async function sendMessage<T>(message: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as Response<T>;
  if (isError(response)) throw new Error(response.error);
  return response;
}

function formatRelative(timestamp: number): string {
  if (!timestamp) return 'never';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function render(state: StateResponse): void {
  elements.globalToggle.checked = state.settings.enabled;

  const failing = state.subscriptions.filter((subscription) => subscription.lastError);
  if (state.installError) {
    elements.listStatus.textContent = state.installError;
    elements.listStatus.classList.add('error');
  } else if (failing.length > 0) {
    elements.listStatus.textContent = `Update failed for ${failing.map((s) => s.title).join(', ')}.`;
    elements.listStatus.classList.add('error');
  } else {
    const newest = Math.max(0, ...state.subscriptions.map((s) => s.lastUpdated));
    elements.listStatus.textContent = `Lists updated ${formatRelative(newest)}.`;
    elements.listStatus.classList.remove('error');
  }

  const tab = state.tab;
  const hasSite = Boolean(tab?.host);
  elements.siteCard.hidden = !hasSite;
  if (tab) {
    elements.siteHost.textContent = tab.host;
    elements.siteToggle.checked = tab.enabled && !tab.whitelisted && !tab.tempAllowed;
    elements.siteToggle.disabled = !state.settings.enabled;

    if (tab.whitelisted) {
      elements.whitelistButton.textContent = 'Remove from whitelist';
      elements.siteHint.textContent = 'This site is permanently allowed: nothing is blocked or hidden.';
    } else if (tab.tempAllowed) {
      elements.whitelistButton.textContent = 'Allow permanently';
      elements.siteHint.textContent = 'Paused for this tab until it closes.';
    } else {
      elements.whitelistButton.textContent = 'Allow permanently';
      elements.siteHint.textContent = '';
    }
  }

  elements.todaySite.textContent = String(tab ? (state.stats.todayBySite[tab.host] ?? 0) : 0);
  elements.todayTotal.textContent = String(state.stats.todayTotal);
}

async function refresh(): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = activeTab?.id;
  const state = await sendMessage<StateResponse>({ type: 'getState', tabId: currentTabId });
  render(state);
}

async function main(): Promise<void> {
  elements.globalToggle.addEventListener('change', () => {
    void (async () => {
      try {
        await sendMessage({ type: 'setGlobalEnabled', enabled: elements.globalToggle.checked });
        await refresh();
      } catch (error) {
        showStatus(error instanceof Error ? error.message : String(error), true);
      }
    })();
  });

  elements.siteToggle.addEventListener('change', () => {
    if (currentTabId === undefined) return;
    const enabled = elements.siteToggle.checked;
    void (async () => {
      try {
        await sendMessage({ type: 'setSiteEnabled', tabId: currentTabId, enabled });
        await refresh();
      } catch (error) {
        showStatus(error instanceof Error ? error.message : String(error), true);
      }
    })();
  });

  elements.whitelistButton.addEventListener('click', () => {
    void (async () => {
      try {
        const result = await sendMessage<{ host: string; allowed: boolean }>({
          type: 'setWhitelisted',
          tabId: currentTabId,
        });
        showStatus(
          result.allowed ? `${result.host} is now allowed.` : `${result.host} is blocked again.`,
        );
        await refresh();
      } catch (error) {
        showStatus(error instanceof Error ? error.message : String(error), true);
      }
    })();
  });

  elements.updateButton.addEventListener('click', () => {
    elements.updateButton.disabled = true;
    void (async () => {
      try {
        const result = await sendMessage<{
          summary: { updated: string[]; failed: Array<{ title: string; error: string }> };
        }>({ type: 'updateLists' });
        if (result.summary.failed.length > 0) {
          showStatus(`Update failed: ${result.summary.failed[0]!.error}`, true, true);
        } else {
          showStatus(`Lists updated (${result.summary.updated.length}).`);
        }
        await refresh();
      } catch (error) {
        showStatus(error instanceof Error ? error.message : String(error), true);
      } finally {
        elements.updateButton.disabled = false;
      }
    })();
  });

  elements.optionsButton.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  await refresh();
}

void main();
