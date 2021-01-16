import { HLClock } from './HLClock';
import { HLTime } from './HLTime';
import { isValidOplogEntry, makeNodeId } from './utils';

export enum STORE_NAME {
  META = 'IDBSideSync_MetaStore',
  OPLOG = 'IDBSideSync_OpLogStore',
}

export const OPLOG_STORE = STORE_NAME.OPLOG;
export const OPLOG_INDEX = 'Indexed by: store, objectKey, prop, hlcTime';

let dbSingleton: IDBDatabase;
let cachedSettings: Settings;

/**
 * This should be called as part of the upstream library handling an onupgradeneeded event (i.e., this won't be called
 * every time an app starts up--only when the database version changes).
 */
export function onupgradeneeded(event: IDBVersionChangeEvent): void {
  const db = (event.target as IDBOpenDBRequest).result;

  // Create an object store where we can put IDBSideSync settings that won't be sync'ed. Note the lack of a keypath.
  // This means that a "key" arg will need to be specified when calling `add()` or `put()`.
  db.createObjectStore(STORE_NAME.META);

  // This is technically unnecessary, but a nice way to help make sure we're always referencing a valid OpLogEntry
  // property name when defining a `keyPath` for the object store.
  const storeKeyPath: keyof OpLogEntry = 'hlcTime';

  const oplogStore = db.createObjectStore(STORE_NAME.OPLOG, { keyPath: storeKeyPath });

  // Create an index tailored to finding the most recent oplog entry for a given store + object key + prop. Note:
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
  // object and prop are grouped together AND sorted by `hlcTime`.
  //
  // Note that while we are not going to use this index to SEARCH by `hlcTime`, we do want the index keys to be SORTED
  // based on `hlcTime` (after first being sorted by store, objectKey, and prop). In other words, the only reason
  // `hlcTime` is included in the index `keyPath` is to affect the sorting.
  //
  // For more info see https://stackoverflow.com/a/15625231/62694.
  const indexKeyPath: Array<keyof OpLogEntry> = ['store', 'objectKey', 'prop', 'hlcTime'];
  oplogStore.createIndex(OPLOG_INDEX, indexKeyPath);
}

/**
 * Allow IDBSideSync to initialize itself with the provided IndexedDB database.
 */
export async function init(db: IDBDatabase): Promise<void> {
  if (!db || !db.createObjectStore) {
    throw new TypeError(`IDBSideSync.init(): 'db' arg must be an instance of IDBDatabase.`);
  }
  dbSingleton = db;
  const settings = await initSettings();
  HLClock.setTime(new HLTime(0, 0, settings.nodeId));
}

/**
 * Ensures that IDBSideSync has required settings in its own IndexedDB store (e.g., a unique node ID that identifies
 * all the oplog entries created by the application instance).
 */
export async function initSettings(): Promise<typeof cachedSettings> {
  if (cachedSettings) {
    return cachedSettings;
  }

  await txWithStore([STORE_NAME.META], 'readwrite', (store) => {
    const getReq = store.get('settings');
    getReq.onsuccess = () => {
      if (getReq.result) {
        cachedSettings = getReq.result;
      } else {
        cachedSettings = {
          nodeId: makeNodeId(),
        };
        store.put(cachedSettings, 'settings');
      }
    };
  });

  return cachedSettings;
}

export async function applyOplogEntries(candidates: OpLogEntry[]) {
  for (const candidate of candidates) {
    await applyOplogEntry(candidate);
  }
}

/**
 * Attempt to apply an oplog entry. In other words, check to see if the oplog entry (which we'll call the "candidate
 * entry") is actually the most recent entry (based on the `hlcTime` value) for the specified store + objectKey + prop
 * that it is attempting to mutate. If no other oplog entries exist with that criteria, or if they do and the candidate
 * has an `hlcTime` value that occurs _after_ the existing entries, then update (or create) the object specified by the
 * candidate entry's `objectKey` and ensure that it has the prop and value specified by the candidate.
 *
 * After the candidate entry has been used to create/update the appropriate target object, add it to the local
 * OpLogEntry store.
 *
 * Important: all of the IndexedDB operations performed by this function should happen in the same transaction. This
 * means that, once the transaction begins, no more promises should be used--all code should be written in a way that
 * ensures the transaction is not committed before all operations have finished.
 */
export async function applyOplogEntry(candidate: OpLogEntry) {
  await txWithStore([STORE_NAME.OPLOG, candidate.store], 'readwrite', (oplogStore, targetStore) => {
    const oplogIndex = oplogStore.index(OPLOG_INDEX);

    // Each key in the index (an array) must be "greater than or equal to" the following array (which, in effect, means
    // each element of the key array needs to be >= the corresponding element in the following array). Given the
    // following example bounds and keys, BOTH keys are >= the lower bounds:
    //
    //  - Lower bounds key: ['todo_items', '123', 'name', '']
    //
    //  - Key 1: ['todo_items', '123', 'name', '2021-01-12...'] is included because:
    //    - 'todo_items' >= 'todo_items' and '123' >= '123' and 'name' >= 'name' and '2021-01-12...' >= ''
    //
    //  - Key 2: ['todo_types', '456', 'name', '2021-01-12...'] is included because:
    //    - 'todo_types' >= 'todo_items' and '456' >= '123' and 'name' >= 'name' and '2021-01-12...' >= ''
    //
    // Note that we're using '' for the lower bound of the `hlcTime` key element. This is because we want to include all
    // possible hlcTime values (i.e., we want all possible hlcTime values to be >= this value), and '' is <= all other
    // strings.
    const lowerBound = [candidate.store, candidate.objectKey, candidate.prop, ''];

    // Each key in the index must be "less than or equal to" the following upper bounds key. We're using '9' for the
    // upper bound of the `hlcTime` key element because we want to include all possible hlcTime values (i.e., we want
    // all possible hlcTime values to be LESS THAN OR EQUAL TO this string), and the string '9' should always be >= any
    // hlcTime value (e.g., '9' >= '2021-01-01...', etc.).
    const upperBound = [candidate.store, candidate.objectKey, candidate.prop, '9'];

    // Things to keep in mind when grokking how the oplog index, cursor range, and cursor will work here:
    // 1. The index as a big list, sorted by its `keyPath`, with "smaller" keys at the top.
    //   - The keys are arrays; IndexedDB compares arrays by comparing corresponding array elements
    //   - Full sorting algo: https://www.w3.org/TR/IndexedDB/#key-construct. You can test with `indexedDB.cmp(a,b)`
    // 2. A cursor iterates over some range of that list.
    // 3. The direction param (prev, next) determines if the cursor starts at the "top" or bottom of the range.
    //   - 'next' (default) = start at lower bound, 'prev' = start at upper bound and iterate backwards.
    // 4. IDBKeyRange determines the range of the list over which the cursor will iterate.
    //   - Lower bound: range begins at first key that is >= x.
    //   - Upper bound: range ends at first key that is <= y.
    //   - If no upper bound is specified, cursor can continue to end of index.
    // 5. It may seem like we don't need to use a lower bound (i.e., "if we're just getting the last item from the list,
    //    as determined by the upper bound, so why bother with a lower bound?"). It's important to remember, however,
    //    that the cursor isn't checking for equality--it's only checking for "greater/less than or equal to". So if no
    //    lower bound is specified, and no existing oplog entry exists for this store/key/prop, the first record the
    //    cursor encounters could be for for a DIFFERENT store/key/prop! In other words, it's critical that we use a
    //    lower bound to effectively limit the cursor to entries with matching store/objectKey/prop values. We're
    //    basically doing something like "where x >= 2 and x <= 2 and y >= 7 and y <= 7" to ensure that the cursor only
    //    includes objects where x = 2 and y = 7.
    const idxCursorReq = oplogIndex.openCursor(IDBKeyRange.bound(lowerBound, upperBound), 'prev');

    idxCursorReq.onsuccess = () => {
      const cursor = idxCursorReq.result;

      // The purpose of this block is to see if an existing oplog entry exists that is "newer" than the candidate entry.
      if (cursor && cursor.value) {
        if (!isValidOplogEntry(cursor.value)) {
          console.warn(
            `IDBSideSync: encountered an invalid oplog entry in its "${OPLOG_STORE}" store. This might mean that an` +
              `oplog entry was manually edited or created in an invalid way somewhere. The entry will be ignored.`,
            JSON.stringify(cursor.value)
          );
          cursor.continue();
          return;
        }

        const existing = cursor.value;

        const expectedObjectKey = JSON.stringify(candidate.objectKey);
        const actualObjectKey = JSON.stringify(existing.objectKey);

        // In theory, the cursor range should prevent us from encountering oplog entries that don't match the candidate
        // store/objectKey/prop values. That said, doing some extra checks can't hurt--especially while the code hasn't
        // been thoroughly tested in more than one "production" environment.
        if (existing.store !== candidate.store) {
          throw new UnexpectedOpLogEntryError('store', candidate.store, existing.store);
        } else if (expectedObjectKey !== actualObjectKey) {
          throw new UnexpectedOpLogEntryError('objectKey', expectedObjectKey, actualObjectKey);
        } else if (existing.prop !== candidate.prop) {
          throw new UnexpectedOpLogEntryError('prop', candidate.prop, cursor.value.prop);
        }

        // If we found an existing entry whose HLC timestamp is more recent than the candidate's, then the candidate
        // entry is obsolete and we'll ignore it.
        if (candidate.hlcTime < existing.hlcTime) {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`IDBSideSync: WON'T apply oplog entry; found existing that's newer:`, { candidate, existing });
          }
          return;
        }
      }

      // If the thread of execution makes it this far, it means we didn't find an existing entry with a newer timestamp.
      if (process.env.NODE_ENV !== 'production') {
        console.log(`IDBSideSync: applying oplog entry; didn't find a newer one with matching store/key/prop.`);
      }

      // Add the entry to the oplog store. Note that, in theory, it may already exist there (e.g., it's possible for a
      // sync to happen in which known oplog entries received again). Instead of attempting to check first, we'll just
      // use `put()` to "upsert"--less code and avoids an extra IndexedDB operation.
      const oplogPutReq = oplogStore.put(candidate);

      if (process.env.NODE_ENV !== 'production') {
        oplogPutReq.onsuccess = () => {
          console.info(`IDBSideSync: successfully added oplog entry to "${OPLOG_STORE}".`, candidate);
        };
      }

      oplogPutReq.onerror = (event) => {
        const errMsg = `IDBSideSync: encountered an error while attempting to add an object to "${OPLOG_STORE}".`;
        console.error(errMsg, event);
        throw new Error(errMsg);
      };

      const existingObjReq = targetStore.get(candidate.objectKey);

      existingObjReq.onsuccess = () => {
        const existingValue = existingObjReq.result;

        if (process.env.NODE_ENV !== 'production') {
          existingObjReq.onsuccess = () => {
            console.info(`IDBSideSync: retrieved existing object from "${candidate.store}".`, existingValue);
          };
        }

        const newValue =
          existingValue && typeof existingValue === 'object' && candidate.prop !== ''
            ? { ...existingValue, [candidate.prop]: candidate.value } // "Merge" the new object with the existing object
            : candidate.value;

        // When calling the target object store's `put()` method it's important to NOT include a `key` param if that
        // store has a `keyPath`. Doing this causes an error (e.g., "[...] object store uses in-line keys and the key
        // parameter was provided" in Chrome).
        const mergedPutReq = targetStore.keyPath
          ? targetStore.put(newValue)
          : targetStore.put(newValue, candidate.objectKey);

        if (process.env.NODE_ENV !== 'production') {
          mergedPutReq.onsuccess = () => {
            console.log(`IDBSideSync: successfully applied oplog entry to ${candidate.store}.`, {
              existingValue,
              newValue,
            });
          };
        }
      };

      existingObjReq.onerror = (event) => {
        const errMsg =
          `IDBSideSync: encountered an error while trying to retrieve an object from "${candidate.store}"  as part ` +
          `of applying an oplog entry change to that object.`;
        console.error(errMsg, event);
        throw new Error(errMsg);
      };
    };

    idxCursorReq.onerror = (event) => {
      const errMsg = `IDBSideSync: encountered an error while trying to open a cursor on the "${OPLOG_INDEX}" index.`;
      console.error(errMsg, event);
      throw new Error(errMsg);
    };
  });
}

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
  storeNames: string[],
  mode: Exclude<IDBTransactionMode, 'versionchange'>,
  callback: (...stores: IDBObjectStore[]) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transactionRequest = dbSingleton.transaction(storeNames, mode);
    transactionRequest.oncomplete = () => resolve();
    transactionRequest.onerror = () => reject(transactionRequest.error);
    const stores = storeNames.map((storeName) => transactionRequest.objectStore(storeName));
    callback(...stores);
  });
}

class UnexpectedOpLogEntryError extends Error {
  constructor(noun: keyof OpLogEntry, expected: string, actual: string) {
    super(
      `IDBSideSync: invalid "most recent oplog entry"; expected '${noun}' value of '${expected}' but got ` +
        `'${actual}'. (This might mean there's a problem with the IDBKeyRange used to iterate over ${OPLOG_INDEX}.)`
    );
    Object.setPrototypeOf(this, UnexpectedOpLogEntryError.prototype); // https://preview.tinyurl.com/y4jhzjgs
  }
}