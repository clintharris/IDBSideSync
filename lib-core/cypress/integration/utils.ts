import * as IDBSideSync from '../../src/index';
import * as deepEqual from 'deep-equal';

export const TODOS_DB = 'todos-db';
export const TODO_ITEMS_STORE = 'todos-store';
export const ARR_KEYPATH_STORE = 'store_with_array_keypath';
export const NO_KEYPATH_STORE = 'store_without_keypath';
let dbPromise: Promise<IDBDatabase> | null = null;

export async function clearDb() {
  // If a database connection is open, the attempt to delete it will fail. More specifically, the attempt to delete will
  // be "blocked" and the `onblocked` callback will run.
  if (dbPromise) {
    (await dbPromise).close();
    dbPromise = null;
  }

  return new Promise((resolve, reject) => {
    const delReq = indexedDB.deleteDatabase(TODOS_DB);
    delReq.onsuccess = () => resolve(delReq.result);
    delReq.onerror = () => reject(new Error(`Couldn't delete "${TODOS_DB}" DB between tests; 'onerror' event fired`));
    delReq.onblocked = () => {
      reject(new Error(`Couldn't delete "${TODOS_DB}" DB between tests; This could mean a db conn is still open.`));
    };
  });
}

export async function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const openreq = indexedDB.open(TODOS_DB, 1);
      openreq.onblocked = reject;
      openreq.onerror = reject;
      openreq.onsuccess = () => resolve(openreq.result);
      openreq.onupgradeneeded = (event) => {
        const db = openreq.result;
        IDBSideSync.onupgradeneeded(event);
        db.createObjectStore(TODO_ITEMS_STORE, { keyPath: 'id' });
        db.createObjectStore(ARR_KEYPATH_STORE, { keyPath: ['scope', 'name'] });
        db.createObjectStore(NO_KEYPATH_STORE);
      };
    });
  }
  return dbPromise;
}

/**
 * @return a Promise that resolves with when the transaction 'oncomplete' fires.
 */
export async function resolveOnTxComplete(
  storeNames: string[],
  mode: Exclude<IDBTransactionMode, 'versionchange'>,
  callback: (...stores: IDBObjectStore[]) => void
): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const txReq = db.transaction(storeNames, mode);
    txReq.oncomplete = () => resolve();
    txReq.onabort = reject;
    txReq.onerror = reject;
    const stores = storeNames.map((storeName) => txReq.objectStore(storeName));
    callback(...stores);
  });
}

export function onSuccess(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = reject;
  });
}

export function throwOnReqError(request?: IDBRequest) {
  if (request) {
    request.onerror = (event) => {
      throw event;
    };
  }
}

export function log(message: string, ...args: unknown[]): void {
  console.log('[test] ' + message, ...args);
}

export function warn(message: string, ...args: unknown[]): void {
  console.warn('[test] ' + message, ...args);
}

export function filterEntries(entries: OpLogEntry[], where: Partial<Record<keyof OpLogEntry, unknown>>): OpLogEntry[] {
  return entries.filter((entry: OpLogEntry) => {
    for (const prop in where) {
      if (!deepEqual(entry[prop], where[prop])) {
        return false;
      }
    }
    return true;
  });
}

interface VerifyOptions {
  hasCount: number;
  where: Partial<Record<keyof OpLogEntry, unknown>>;
}

export function assertEntries(entries: OpLogEntry[], { hasCount, where }: VerifyOptions) {
  assert(
    filterEntries(entries, where).length === hasCount,
    `Exactly ${hasCount} OpLogEntry object(s) should exist where ${JSON.stringify(where)}`
  );
}
