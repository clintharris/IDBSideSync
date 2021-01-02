import { HLClock } from './HLClock';
import { HLTime } from './HLTime';
import { makeNodeId } from './utils';

export enum STORE_NAME {
  META = 'IDBSideSync_MetaStore',
  OPLOG = 'IDBSideSync_OpLogStore',
}

export enum INDEX_NAME {
  SOFT_DELETED = 'IDBSideSync_SoftDeletedIndex',
}

export const SOFT_DELETED_PROP = 'IDBSideSync_SoftDeleted';
export const OPLOG_STORE = STORE_NAME.OPLOG;

let dbSingleton: IDBDatabase;
let settings: { nodeId: string };

/**
 * This should be called in the upstream developer's 'onupgradeneeded' handler for every store they want to use with
 * IDBSideSync. It sets up an index that makes it possible to retrieve objects in that store based on whether or not
 * they are "soft deleted" (i.e., have an IDBSideSync-specific prop that indicates they should be treated as being
 * deleted).
 */
export function setupStore(store: IDBObjectStore) {
  store.createIndex(INDEX_NAME.SOFT_DELETED, SOFT_DELETED_PROP, { unique: false });
}

/**
 * This should be called as part of the upstream library handling an onupgradeneeded event (i.e., note that this won't
 * be called every time an app starts up--only when the database version changes).
 */
export function onupgradeneeded(event: IDBVersionChangeEvent): void {
  const db = (event.target as IDBOpenDBRequest).result;

  // Create an object store where we can put random administrata that won't be synced like the oplog entries (e.g., the
  // GUID that identifies the current agent--something that we want to persist between sessions).
  //
  // Note that we're creating the store without a keypath. This means that we'll need to always pass a "key" arg when
  // calling any of the CRUD methods on the store. Example: `store.put("1234", "agent_id"); store.get("agent_id")`.
  db.createObjectStore(STORE_NAME.META);

  // Use `keyof OpLogEntry` type in case OpLogEntry props are ever renamed.
  const keyPath: Array<keyof OpLogEntry> = ['hlcTime', 'store', 'objectKey', 'prop'];
  db.createObjectStore(STORE_NAME.OPLOG, { keyPath });
}

export async function init(db: IDBDatabase): Promise<void> {
  if (!db) {
    throw new TypeError(`Required 'db' arg is not an instance of IDBDatabase.`);
  }
  dbSingleton = db;
  await initSettings();
  HLClock.setTime(new HLTime(0, 0, settings.nodeId));
}

export async function initSettings(): Promise<typeof settings> {
  if (settings) {
    return settings;
  }

  await txWithStore(STORE_NAME.META, 'readwrite', (store) => {
    const getReq = store.get('settings');
    getReq.onsuccess = () => {
      if (getReq.result) {
        settings = getReq.result;
      } else {
        settings = {
          nodeId: makeNodeId(),
        };
        store.put(settings, 'settings');
      }
    };
  });

  return settings;
}

// /**
//  * Use this function to find the most recent oplog entry for the specified store/object if one exists.
//  *
//  * @param storeName
//  * @param idPath
//  * @param idValue
//  */
// async function getMostRecentOpLogEntryFor(storeName: string, idPath: string, idValue: string): Promise<OpLogEntry> {
//   return null;
// }

/**
 * Utility function for initiating an IndexedDB transaction, getting a reference to an object store, and being able to
 * `await` the completion of the transaction (sort of a crude alternative to using alternative to Jake Archibald's `idb`
 * library, and mostly copied from his `svgomg` app here: https://preview.tinyurl.com/yaoxc9cl).
 *
 * @example
 * ```
 * let result;
 * await txWithStore('myStore', 'readwrite', (store) => {
 *   store.add(myThing).onsuccess = (event) => {
 *     result = event.target.result;
 *   };
 * });
 *
 * // Now do something else that may depend on the transaction having completed and 'myThing' having been added...
 * console.log('Your thing was added:', result);
 * ```
 *
 * @param storeName - name of object store to retrieve
 * @param mode - "readonly" | "readwrite"
 * @param callback - called immediately with object store
 *
 * @returns a Promise that will resolve once the transaction completes successfully.
 */
async function txWithStore(
  storeName: STORE_NAME,
  mode: Exclude<IDBTransactionMode, 'versionchange'>,
  callback: (store: IDBObjectStore) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transactionRequest = dbSingleton.transaction(storeName, mode);
    transactionRequest.oncomplete = () => resolve();
    transactionRequest.onerror = () => reject(transactionRequest.error);
    callback(transactionRequest.objectStore(storeName));
  });
}
