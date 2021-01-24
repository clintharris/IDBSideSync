import * as IDBSideSync from '../../src/index';
import * as deepEqual from 'deep-equal';

export const TODOS_DB = 'todos-db';
export const TODO_ITEMS_STORE = 'todos-store';
export const SCOPED_SETTINGS_STORE = 'scoped-settings-store';
export const GLOBAL_SETTINGS_STORE = 'global-settings-store';
let dbPromise: Promise<IDBDatabase> | null = null;

export async function deleteDb() {
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
        db.createObjectStore(TODO_ITEMS_STORE, { keyPath: 'id' }); // For testing store with simple one-prop keyPath
        // Tests store with compound keyPath
        db.createObjectStore(SCOPED_SETTINGS_STORE, { keyPath: ['scope', 'name'] });
        db.createObjectStore(GLOBAL_SETTINGS_STORE); // Tests store without any keyPath
      };
    });
  }
  return dbPromise;
}

/**
 * A convenience function that makes it possible to write easier-to-read async code that awaits both the completion
 * of async callback code that uses IndexedDB object stores, and the overall completion of the IndexedDB transaction.
 *
 * @example
 * ```
 * let thing1;
 * let thing2;
 *
 * await resolveOnTxComplete(['myStore1', 'myStore2'], 'readwrite', async (myStore1, mystore2) => {
 *    thing1 = await resolveRequest(myStore1.get(111));
 *    thing2 = await resolveRequest(myStore2.get(222));
 * }
 *
 * // Do stuff with thing1 and thing2...
 * ```
 *
 * @return a Promise that resolves after both the passed-in 'callback' resolves AND the transaction 'oncomplete' fires.
 */
export async function resolveOnTxComplete(
  storeNames: string[],
  mode: Exclude<IDBTransactionMode, 'versionchange'>,
  callback: (...stores: IDBObjectStore[]) => Promise<void>
): Promise<unknown> {
  const db = await getDb();
  const txReq = db.transaction(storeNames, mode);
  const stores = storeNames.map((storeName) => txReq.objectStore(storeName));

  const transactionCompletePromise = new Promise((resolve, reject) => {
    txReq.oncomplete = () => {
      resolve(txReq);
    };
    txReq.onabort = () => reject(new Error('Transaction aborted.'));
    txReq.onerror = (event) => {
      // @ts-ignore
      reject(event.target.error);
    };
  });

  // Return a promise that won't resolve until both the callback() and transaction have resolved/completed. Note that
  // callback() doesn't *have* to return a promise (e.g., it's possible that the callback won't be declared as "async";
  // you can pass non-promises to Promise.all().
  return Promise.all([callback(...stores), transactionCompletePromise]);
}

export function resolveRequest(request) {
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

export function waitForAFew(msec = 50): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, msec);
  });
}
