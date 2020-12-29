export const oploggyDbName = 'oploggy';
export const oplogStoreName = 'OpLogEntries';

let dbSingleton: Promise<IDBDatabase>;

export function getOpLoggyDb() {
  if (!dbSingleton) {
    dbSingleton = new Promise((resolve, reject) => {
      const openreq = indexedDB.open(oploggyDbName, 1);

      openreq.onerror = () => {
        reject(openreq.error);
      };

      openreq.onupgradeneeded = () => {
        // We could just pass a string constant to the `keyPath`, but declaring it with `keyof OpLogEntry` is safer
        // and will let the compiler warn us if the interface or key name change in the future.
        const oplogEntryKeyName: keyof OpLogEntry = 'hlcTime';
        const oplogStore = openreq.result.createObjectStore(oplogStoreName, { keyPath: oplogEntryKeyName });

        // We'll frequently need to query by store, idPath, and idValue. "What is the most recent oplog entry for the
        // 'customers' object store where customerId = 123?", for example, translates to a query where `store =
        // 'customers' AND idPath = 'customerId' AND idValue = 123`.
        oplogStore.createIndex('store', 'store', { unique: false });
        oplogStore.createIndex('idPath', 'idPath', { unique: false });
        oplogStore.createIndex('idValue', 'idValue', { unique: false });

      };

      openreq.onsuccess = () => {
        resolve(openreq.result);
      };
    });
  }
  return dbSingleton;
}

export async function getStore(db: IDBDatabase, storeName: string, type: IDBTransactionMode): Promise<IDBObjectStore> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, type);
    transaction.oncomplete = () => {
      resolve(transaction.objectStore(oplogStoreName));
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Use this function to find the most recent oplog entry for the specified store/object if one exists.
 *
 * @param storeName
 * @param idPath
 * @param idValue
 */
async function getMostRecentOpLogEntryFor(
  storeName: string,
  idPath: string,
  idValue: string
): Promise<OpLogEntry | null> {
  return null;
}
