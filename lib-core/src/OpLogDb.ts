export const IDB_SIDESYNC_META_STORE = 'idb-sidesync_non-synced-meta';
export const IDB_SIDESYNC_OPLOG_STORE = 'idb-sidesync_oplog';

let dbSingleton: IDBDatabase;

export function setupSideSyncStores(db: IDBDatabase) {
  dbSingleton = db;

  // Create an object store where we can put random administrata that won't be synced like the oplog entries (e.g., the
  // GUID that identifies the current agent--something that we want to persist between sessions).
  //
  // Note that we're creating the store without a keypath. This means that we'll need to always pass a "key" arg when
  // calling any of the CRUD methods on the store. Example: `store.put("1234", "agent_id"); store.get("agent_id")`.
  db.createObjectStore(IDB_SIDESYNC_META_STORE);

  // Use `keyof OpLogEntry` type in case OpLogEntry props are ever renamed.
  const keyPath: Array<keyof OpLogEntry> = ['hlcTime', 'store', 'objectId', 'field'];
  db.createObjectStore(IDB_SIDESYNC_OPLOG_STORE, { keyPath });
}

export async function getStore(storeName: string, type: IDBTransactionMode): Promise<IDBObjectStore> {
  return new Promise((resolve, reject) => {
    const transaction = dbSingleton.transaction(storeName, type);
    transaction.oncomplete = () => {
      resolve(transaction.objectStore(storeName));
    };
    transaction.onerror = () => reject(transaction.error);
  });
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
