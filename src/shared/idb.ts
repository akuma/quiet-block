/**
 * Minimal IndexedDB wrapper.
 *
 * Used for the bulky raw filter-list text, which would otherwise eat into the
 * 10 MB chrome.storage.local quota that the settings, whitelist and statistics
 * share. Note that content scripts read IndexedDB in the *page's* origin, so
 * nothing the content script needs may be stored here - see cosmetic.ts.
 */

import { IDB } from './constants.ts';

export type ListRecord = {
  id: string;
  text: string;
  hash: string;
  updatedAt: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this context'));
      return;
    }
    const request = indexedDB.open(IDB.name, IDB.version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB.lists)) {
        db.createObjectStore(IDB.lists, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
  });
  return dbPromise;
}

async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = run(transaction.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return withStore<T | undefined>(store, 'readonly', (objectStore) => objectStore.get(key) as IDBRequest<T | undefined>);
}

export async function idbPut(store: string, value: unknown): Promise<void> {
  await withStore(store, 'readwrite', (objectStore) => objectStore.put(value) as IDBRequest<IDBValidKey>);
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  await withStore(store, 'readwrite', (objectStore) => objectStore.delete(key) as IDBRequest<undefined>);
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  return withStore<T[]>(store, 'readonly', (objectStore) => objectStore.getAll() as IDBRequest<T[]>);
}

export async function idbClear(store: string): Promise<void> {
  await withStore(store, 'readwrite', (objectStore) => objectStore.clear() as IDBRequest<undefined>);
}

/* --------------------------- typed accessors --------------------------- */

export async function getListRecord(id: string): Promise<ListRecord | undefined> {
  return idbGet<ListRecord>(IDB.lists, id);
}

export async function putListRecord(record: ListRecord): Promise<void> {
  await idbPut(IDB.lists, record);
}

export async function getAllListRecords(): Promise<ListRecord[]> {
  return idbGetAll<ListRecord>(IDB.lists);
}

/** FNV-1a, used to detect whether a list's text actually changed. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/* --------------------- cosmetic bundle (storage.local) --------------------- */

/**
 * The compiled cosmetic selectors live in chrome.storage.local rather than
 * IndexedDB because a content script reads IndexedDB in the origin of the page
 * it is injected into, not the extension's origin. chrome.storage.local is
 * shared by every extension context.
 */
export const COSMETIC_KEY = 'cosmeticBundle';

export type CosmeticBundleRecord = {
  version: number;
  bundle: unknown;
};

export async function putCosmeticRecord(version: number, bundle: unknown): Promise<void> {
  await chrome.storage.local.set({ [COSMETIC_KEY]: { version, bundle } satisfies CosmeticBundleRecord });
}

export async function getCosmeticRecord(): Promise<CosmeticBundleRecord | undefined> {
  const stored = await chrome.storage.local.get(COSMETIC_KEY);
  return stored[COSMETIC_KEY] as CosmeticBundleRecord | undefined;
}
