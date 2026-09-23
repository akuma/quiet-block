/**
 * Options page controller.
 *
 * Renders the whole persisted state and sends one message per user action.
 * Nothing is cached here: every action re-reads the state from the worker so
 * the page can never drift out of sync with what is actually installed.
 */

import type { StateResponse } from '../shared/types.ts';

type Response<T> = T | { ok: false; error: string };

function isError<T>(value: Response<T>): value is { ok: false; error: string } {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const elements = {
  globalToggle: byId<HTMLInputElement>('global-toggle'),
  updateInterval: byId<HTMLSelectElement>('update-interval'),
  whitelistSummary: byId<HTMLElement>('whitelist-summary'),
  rows: byId<HTMLTableSectionElement>('subscription-rows'),
  addForm: byId<HTMLFormElement>('add-form'),
  addUrl: byId<HTMLInputElement>('add-url'),
  addHint: byId<HTMLElement>('add-hint'),
  customRules: byId<HTMLTextAreaElement>('custom-rules'),
  saveRules: byId<HTMLButtonElement>('save-rules'),
  importRules: byId<HTMLButtonElement>('import-rules'),
  exportRules: byId<HTMLButtonElement>('export-rules'),
  importArea: byId<HTMLTextAreaElement>('import-area'),
  rulesHint: byId<HTMLElement>('rules-hint'),
  statsToggle: byId<HTMLInputElement>('stats-toggle'),
  statsNote: byId<HTMLElement>('stats-note'),
  budgetNote: byId<HTMLElement>('budget-note'),
  statsRows: byId<HTMLTableSectionElement>('stats-rows'),
  clearStats: byId<HTMLButtonElement>('clear-stats'),
  version: byId<HTMLElement>('version'),
};

let state: StateResponse | null = null;

async function sendMessage<T>(message: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as Response<T>;
  if (isError(response)) throw new Error(response.error);
  return response;
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp) return 'never';
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ----------------------------- rendering ------------------------------ */

function renderSubscriptions(): void {
  if (!state) return;
  elements.rows.textContent = '';

  for (const subscription of state.subscriptions) {
    const row = document.createElement('tr');

    const title = document.createElement('td');
    const titleText = document.createElement('span');
    titleText.className = 'list-title';
    titleText.textContent = subscription.title;
    title.append(titleText);
    const meta = document.createElement('span');
    meta.className = 'list-meta';
    meta.textContent =
      subscription.kind === 'remote'
        ? (subscription.url ?? '')
        : subscription.kind === 'builtin'
          ? (subscription.homepage ?? '')
          : 'Edited in the box below';
    title.append(meta);
    if (subscription.lastError) {
      const error = document.createElement('span');
      error.className = 'list-error';
      error.textContent = subscription.lastError;
      title.append(error);
    }

    const rules = document.createElement('td');
    rules.className = 'num';
    rules.textContent = `${subscription.ruleCount.toLocaleString()} rules`;
    if (subscription.dnrRuleCount !== subscription.ruleCount) {
      const merged = document.createElement('span');
      merged.className = 'list-meta';
      merged.textContent = `merged into ${subscription.dnrRuleCount.toLocaleString()} Chrome rules`;
      rules.append(merged);
    }
    if (subscription.droppedCount > 0) {
      const note = document.createElement('span');
      note.className = 'list-meta';
      note.textContent = `+${subscription.droppedCount.toLocaleString()} dropped (rule budget)`;
      rules.append(note);
    }
    if (subscription.cosmeticCount > 0) {
      const cosmetic = document.createElement('span');
      cosmetic.className = 'list-meta';
      cosmetic.textContent = `${subscription.cosmeticCount.toLocaleString()} hiding rules`;
      rules.append(cosmetic);
    }

    const updated = document.createElement('td');
    updated.className = 'num';
    updated.textContent = formatTimestamp(subscription.lastUpdated);

    const actions = document.createElement('td');
    actions.className = 'actions';
    // The controls live in their own flex row: the cell itself has to stay a
    // table cell, and this row is what lets them wrap onto a second line when
    // the panel is narrow instead of spilling past its border.
    const actionRow = document.createElement('div');
    actionRow.className = 'action-row';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = subscription.enabled;
    toggle.title = subscription.enabled ? 'Disable this list' : 'Enable this list';
    toggle.addEventListener('change', () => {
      void run(async () => {
        await sendMessage({
          type: 'setSubscriptionEnabled',
          id: subscription.id,
          enabled: toggle.checked,
        });
      });
    });
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'inline-switch';
    toggleLabel.append(toggle);
    actionRow.append(toggleLabel);

    actionRow.append(
      iconButton('↑', 'Move up', () => {
        void run(async () => {
          await sendMessage({ type: 'moveSubscription', id: subscription.id, direction: -1 });
        });
      }),
      iconButton('↓', 'Move down', () => {
        void run(async () => {
          await sendMessage({ type: 'moveSubscription', id: subscription.id, direction: 1 });
        });
      }),
    );

    if (subscription.kind === 'remote') {
      actionRow.append(
        iconButton('Update', 'Update this list now', () => {
          void run(async () => {
            await sendMessage({ type: 'updateLists' });
          });
        }),
      );
    }
    if (subscription.kind !== 'builtin' && subscription.kind !== 'custom') {
      actionRow.append(
        iconButton('Remove', `Remove ${subscription.title}`, () => {
          void run(async () => {
            await sendMessage({ type: 'removeSubscription', id: subscription.id });
          });
        }),
      );
    }

    actions.append(actionRow);
    row.append(title, rules, updated, actions);
    elements.rows.append(row);
  }
}

function iconButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn small';
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

function renderStats(): void {
  if (!state) return;
  elements.statsRows.textContent = '';
  for (const day of [...state.stats.byDay].reverse()) {
    const row = document.createElement('tr');

    const date = document.createElement('td');
    date.textContent = day.date;
    date.className = 'num';

    const total = document.createElement('td');
    total.className = 'num';
    total.textContent = day.total.toLocaleString();

    const top = document.createElement('td');
    top.textContent =
      day.top.length === 0
        ? '—'
        : day.top.map(([site, count]) => `${site} (${count})`).join(', ');

    row.append(date, total, top);
    elements.statsRows.append(row);
  }
}

function render(): void {
  if (!state) return;
  elements.globalToggle.checked = state.settings.enabled;
  elements.updateInterval.value = String(state.settings.updateIntervalHours);
  elements.statsToggle.checked = state.settings.statsEnabled;

  const whitelist = state.whitelist;
  elements.whitelistSummary.textContent =
    whitelist.length === 0
      ? 'No sites are permanently allowed.'
      : `Allowed: ${whitelist.join(', ')}`;

  const installed = state.budget.installed;
  const limit = state.budget.dynamicLimit;
  elements.budgetNote.textContent =
    `${state.budget.patterns.toLocaleString()} filter rules are installed as ` +
    `${installed.toLocaleString()} of the ${limit.toLocaleString()} Chrome rules an extension may ` +
    `hold. Plain domain rules are merged into rules that carry a domain list, which is how the ` +
    `whole list fits.`;

  renderSubscriptions();
  renderStats();
}

/* ------------------------------ actions ------------------------------- */

let busy = false;

async function run(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await action();
    state = await sendMessage<StateResponse>({ type: 'getState' });
    render();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
  }
}

function hint(element: HTMLElement, message: string, isError = false): void {
  element.textContent = message;
  element.classList.toggle('error', isError);
}

async function main(): Promise<void> {
  elements.version.textContent = chrome.runtime.getManifest().version;

  elements.globalToggle.addEventListener('change', () => {
    void run(async () => {
      await sendMessage({ type: 'setGlobalEnabled', enabled: elements.globalToggle.checked });
    });
  });

  elements.updateInterval.addEventListener('change', () => {
    void run(async () => {
      await sendMessage({ type: 'setUpdateInterval', hours: Number(elements.updateInterval.value) });
    });
  });

  elements.statsToggle.addEventListener('change', () => {
    void run(async () => {
      await sendMessage({ type: 'setStatsEnabled', enabled: elements.statsToggle.checked });
    });
  });

  elements.clearStats.addEventListener('click', () => {
    void run(async () => {
      await sendMessage({ type: 'clearStats' });
    });
  });

  elements.addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = elements.addUrl.value.trim();
    if (!url) return;
    hint(elements.addHint, 'Adding list…');
    void (async () => {
      try {
        // A list on a host we do not already have access to needs the user's
        // consent; asking here keeps the click gesture intact.
        const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
        const origin = `${parsed.protocol}//${parsed.hostname}/*`;
        const granted = await chrome.permissions.contains({ origins: [origin] });
        if (!granted) {
          const requested = await chrome.permissions.request({ origins: [origin] });
          if (!requested) {
            hint(elements.addHint, `QuietBlock needs access to ${parsed.hostname} to read this list.`, true);
            return;
          }
        }
      } catch {
        hint(elements.addHint, 'That does not look like a valid list URL.', true);
        return;
      }
      await run(async () => {
        await sendMessage({ type: 'addSubscription', url });
      });
      elements.addUrl.value = '';
      hint(elements.addHint, 'List added.');
    })();
  });

  elements.saveRules.addEventListener('click', () => {
    hint(elements.rulesHint, 'Saving…');
    void run(async () => {
      await sendMessage({ type: 'setCustomRules', text: elements.customRules.value });
    }).then(() => hint(elements.rulesHint, 'Rules saved and applied.'));
  });

  // One import button, reused: pressing "Import..." again just re-focuses the
  // text area rather than stacking up another button.
  const importConfirm = document.createElement('button');
  importConfirm.type = 'button';
  importConfirm.className = 'btn primary';
  importConfirm.textContent = 'Replace my rules with this';
  importConfirm.hidden = true;
  importConfirm.addEventListener('click', () => {
    void run(async () => {
      await sendMessage({ type: 'importRules', text: elements.importArea.value });
    }).then(() => {
      elements.importArea.hidden = true;
      importConfirm.hidden = true;
      elements.customRules.value = elements.importArea.value;
      hint(elements.rulesHint, 'Rules imported and applied.');
    });
  });
  elements.importArea.after(importConfirm);

  elements.importRules.addEventListener('click', () => {
    elements.importArea.hidden = false;
    importConfirm.hidden = false;
    elements.importArea.value = '';
    elements.importArea.focus();
    hint(elements.rulesHint, 'Paste a filter list, then press "Replace my rules with this".');
  });

  elements.exportRules.addEventListener('click', () => {
    void (async () => {
      const result = await sendMessage<{ text: string }>({ type: 'exportRules' });
      elements.customRules.value = result.text;
      elements.customRules.select();
      hint(elements.rulesHint, 'Your rules are shown above, ready to copy.');
    })();
  });

  state = await sendMessage<StateResponse>({ type: 'getState' });
  elements.customRules.value = state.customRules;
  render();
}

void main();
