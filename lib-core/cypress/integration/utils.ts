import * as IDBSideSync from '../../src/index';

export const TODOS_DB = 'todos-db';
export const TODO_ITEMS_STORE = 'todos-store';
export const TODO_SETTINGS_STORE = 'todos-settings';
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
        db.createObjectStore(TODO_SETTINGS_STORE, { keyPath: ['scope', 'name'] });
      };
    });
  }
  return dbPromise;
}

export async function txWithStore(
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
