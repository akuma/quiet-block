/**
 * Blocked-request statistics.
 *
 * Counts come from `declarativeNetRequest.onRuleMatchedDebug`, which Chrome
 * only dispatches to unpacked extensions - which is the only way QuietBlock is
 * distributed. When the event is unavailable the counters simply stay at zero
 * and the popup says so instead of inventing numbers.
 *
 * Data never leaves the machine: it lives in chrome.storage.local under
 * `stats.<YYYY-MM-DD>`. The in-memory buffer is flushed on a timer, on service
 * worker suspend, and on demand whenever the UI asks for numbers, so at most a
 * couple of seconds of counts can be lost if Chrome kills the worker.
 */

import { STATS_HISTORY_DAYS, STATS_TOP_N, STORAGE_KEYS } from '../shared/constants.ts';
import { lastDayKeys, mergeDay, readDays, topSites, type StatsDelta } from '../shared/stats.ts';
import { statsKey, todayKey } from '../shared/storage.ts';
import type { StatsDay } from '../shared/types.ts';

const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_THRESHOLD = 200;

type Buffer = StatsDelta & { dirty: boolean };

const emptyBuffer = (): Buffer => ({ total: 0, bySite: {}, dirty: false });

class StatsRecorder {
  private buffer: Buffer = emptyBuffer();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  /** True once the browser has confirmed the debug event actually fires. */
  private eventSeen = false;

  setEnabled(enabled: boolean): void {
    if (!enabled) {
      this.buffer = emptyBuffer();
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
  }

  /** Records one blocked request attributed to `host`. */
  record(host: string): void {
    this.eventSeen = true;
    this.buffer.total++;
    this.buffer.bySite[host] = (this.buffer.bySite[host] ?? 0) + 1;
    this.buffer.dirty = true;
    if (this.buffer.total >= FLUSH_THRESHOLD) {
      void this.flush();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  /** Moves the in-memory buffer into storage.local. */
  async flush(): Promise<void> {
    if (this.flushing || !this.buffer.dirty) return;
    this.flushing = true;
    const delta: StatsDelta = { total: this.buffer.total, bySite: { ...this.buffer.bySite } };
    this.buffer = emptyBuffer();
    try {
      const key = statsKey(todayKey());
      const stored = await chrome.storage.local.get(key);
      const current = stored[key] as StatsDay | undefined;
      await chrome.storage.local.set({ [key]: mergeDay(current, delta) });
    } catch {
      // Put the counts back so a transient storage error does not lose them.
      this.buffer.total += delta.total;
      for (const [host, count] of Object.entries(delta.bySite)) {
        this.buffer.bySite[host] = (this.buffer.bySite[host] ?? 0) + count;
      }
      this.buffer.dirty = true;
    } finally {
      this.flushing = false;
    }
  }

  /** Flushes, then reads today plus the recent history. */
  async read(): Promise<{
    todayTotal: number;
    todayBySite: Record<string, number>;
    byDay: Array<{ date: string; total: number; top: Array<[string, number]> }>;
    eventSeen: boolean;
  }> {
    await this.flush();
    const keys = lastDayKeys(STATS_HISTORY_DAYS);
    const dump = await chrome.storage.local.get(keys.map((key) => `${STORAGE_KEYS.statsPrefix}${key}`));
    const days = readDays(dump, keys);
    const today = days[days.length - 1]?.day ?? { total: 0, bySite: {} };
    return {
      todayTotal: today.total,
      todayBySite: today.bySite,
      byDay: days.map(({ date, day }) => ({ date, total: day.total, top: topSites(day, STATS_TOP_N) })),
      eventSeen: this.eventSeen,
    };
  }

  async clear(): Promise<void> {
    this.buffer = emptyBuffer();
    const keys = lastDayKeys(STATS_HISTORY_DAYS).map((key) => statsKey(key));
    await chrome.storage.local.remove(keys);
  }
}

export const stats = new StatsRecorder();
