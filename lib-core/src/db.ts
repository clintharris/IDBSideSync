import { HLClock } from './HLClock';
import { HLTime } from './HLTime';
import { makeNodeId } from './utils';

export enum STORE_NAME {
  META = 'IDBSideSync_MetaStore',
  OPLOG = 'IDBSideSync_OpLogStore',
}

export const OPLOG_STORE = STORE_NAME.OPLOG;
export const OPLOG_INDEX = 'Indexed by: store, objectKey, prop, hlcTime';

let dbSingleton: IDBDatabase;
let settings: { nodeId: string };

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

  // Use `keyof OpLogEntry` type in case OpLogEntry props are ever renamed. Note that the FIRST key (and only the first
  // key) in the `keyPath` determines how the objects will be sorted by default (e.g., the order they'd appear in
  // `getAll()` results).
  const storeKeyPath: keyof OpLogEntry = 'hlcTime';
  const oplogStore = db.createObjectStore(STORE_NAME.OPLOG, { keyPath: storeKeyPath });

  // The purpose of this index will be to find the most recent oplog entry for a given store + object key + prop. This
  // means that:
  //
  //  1. The index will have an entry for each object in the object store that has a "non-empty" value for EVERY prop
  //     (i.e., the object needs to have the prop defined and the value is not null, undefined, or a boolean).
  //  2. The index key for the object will be an array consisting of the values for the corresponding prop values.
  //  3. The index is sorted by the keys. In this case, each key is an array; the IndexedDB spec defines an algo for how
  //     arrays are compared and sorted (see https://www.w3.org/TR/IndexedDB/#key-construct).
  //  4. This basically amounts comparing each element of both arrays, using the same comparison algo.
  //  5. Note that the IndexedDB comparison algo sometimes determines order based on the TYPE of a thing, not its value
  //     (e.g., an array is considered "greater than" a string). This matters for the 'objectKey' prop since that prop
  //     value could be a string, number, Date, or array of those things.
  //
  // Since our only use case will be searching for entries that have a matching store + objectKey + prop (and needing
  // those to be sorted by hlcTime so we can get the most recent), we aren't concerned with how the index entries
  // initially sorted based on 'store' and 'objectKey' (i.e., we don't care if the index key for Object A comes before
  // the one for Object B because of their 'objectKey' values). We only care that all of oplog entries for a specific
  // object and prop are grouped together.
  //
  // For more info see https://stackoverflow.com/a/15625231/62694.
  const indexKeyPath: Array<keyof OpLogEntry> = ['store', 'objectKey', 'prop', 'hlcTime'];
  oplogStore.createIndex(OPLOG_INDEX, indexKeyPath);
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
