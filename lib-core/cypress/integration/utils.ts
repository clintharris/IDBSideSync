import * as IDBSideSync from '../../src/index';
import * as deepEqual from 'deep-equal';

export const TODOS_DB = 'todos-db';
export const TODO_ITEMS_STORE = 'todos-store';
export const SCOPED_SETTINGS_STORE = 'scoped-settings-store';
export const GLOBAL_SETTINGS_STORE = 'global-settings-store';
let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * A convenience function for deleting the IndexedDB database used by the tests.
 *
 * 👉 Note that this function is deliberately NOT written with async/await, such as follows:
 * @example
 * ```
 * const db = await dbPromise; // Syntax sugar for Promise.resolve(dbPromise).then(...)
 * db?.close();
 * return new Promise((resolve, reject) => {
 *   // promise "executor" function that resolves once the db is deleted
 * })
 * ```
 * This is because the executor function passed to `new Promise(...)` runs immediately; in effect, the code for deleting
 * the database would run _before_ the code for closing the database.
 *
 * In reality that would still work because, according to the IndexedDB docs for `deleteDatabase()`, it will _wait_
 * until all connections have closed (i.e., it will wait until the `db.close()` code eventually runs). But for the sake
 * of clarity, we're structuring the code to so that things run in the correct order and there's less invisible magic.
 */
export function deleteDb(): Promise<void> {
  // Use promise chain to ensure that db is closed before we attempt to delete it.
  return Promise.resolve(dbPromise)
    .then((db) => {
      // If the database is open an attempt to delete it will fail with a "blocked" error, so close it if necessary.
      db?.close();
      dbPromise = null;
    })
    .then(() => {
      // this next "then(callback)" isn't enqueued as a microtask until the preceeding one finishes
      return new Promise((resolve, reject) => {
        const delReq = indexedDB.deleteDatabase(TODOS_DB);
        delReq.onsuccess = () => resolve();
        delReq.onerror = () =>
          reject(new Error(`Couldn't delete "${TODOS_DB}" DB between tests; 'onerror' event fired`));
        delReq.onblocked = () => {
          reject(new Error(`Couldn't delete "${TODOS_DB}" DB between tests; This could mean a db conn is still open.`));
        };
      });
    });
}

export function getDb(): Promise<IDBDatabase> {
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
 * A convenience function that works the same as resolveOnTxComplete() but automatically includes the OpLog store
 * in the transaction and ensures that it is passed as the first argument to the callback.
 */
export async function transaction(storeNames: string[], callback: (...stores: IDBObjectStore[]) => unknown) {
  return resolveOnTxComplete(
    [IDBSideSync.OPLOG_STORE, ...storeNames],
    'readwrite',
    async (oplogStore, ...otherStores) => {
      const proxiedStores = otherStores.map((store) => IDBSideSync.proxyStore(store));
      await callback(...proxiedStores, oplogStore);
      console.log('2. resolveOnTxComplete() callback finished.');
    }
  );
}

export async function resolveOnTxComplete(
  storeNames: string[],
  mode: Exclude<IDBTransactionMode, 'versionchange'>,
  callback: (...stores: IDBObjectStore[]) => Promise<void>
): Promise<unknown> {
  const db = await getDb();
  return IDBSideSync.utils.transaction(db, storeNames, mode, callback);
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
