/**
 * Statistics helpers.
 *
 * All numbers stay on the device: they are written to chrome.storage.local and
 * never leave it. Nothing here talks to the network.
 */

import { STATS_TOP_N } from './constants.ts';
import type { StatsDay } from './types.ts';

export type StatsDelta = { total: number; bySite: Record<string, number> };

export const EMPTY_DAY: StatsDay = { total: 0, bySite: {} };

/** Adds `delta` into `day`, returning a new object. */
export function mergeDay(day: StatsDay | undefined, delta: StatsDelta): StatsDay {
  const bySite: Record<string, number> = { ...(day?.bySite ?? {}) };
  for (const [site, count] of Object.entries(delta.bySite)) {
    bySite[site] = (bySite[site] ?? 0) + count;
  }
  return { total: (day?.total ?? 0) + delta.total, bySite };
}

/** Highest-count sites first. */
export function topSites(day: StatsDay | undefined, limit = STATS_TOP_N): Array<[string, number]> {
  if (!day) return [];
  return Object.entries(day.bySite)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

/** Local-calendar date keys for the last `count` days, oldest first. */
export function lastDayKeys(count: number, now: Date = new Date()): string[] {
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    keys.push(`${date.getFullYear()}-${month}-${day}`);
  }
  return keys;
}

/** Reads the per-day records for the given keys out of a storage dump. */
export function readDays(
  dump: Record<string, unknown>,
  keys: readonly string[],
): Array<{ date: string; day: StatsDay }> {
  const result: Array<{ date: string; day: StatsDay }> = [];
  for (const key of keys) {
    const value = dump[`stats.${key}`] as StatsDay | undefined;
    result.push({ date: key, day: value ?? EMPTY_DAY });
  }
  return result;
}
