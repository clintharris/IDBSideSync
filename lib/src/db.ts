/// <reference types="../../types/common" />

import { HLClock } from './HLClock';
import { HLTime } from './HLTime';
import { MerkleTree } from './MerkleTree';
import {
  debug,
  isEventWithTargetError,
  throwIfInvalidOpLogEntry,
  isValidSideSyncSettings,
  libName,
  log,
  makeNodeId,
  transaction,
} from './utils';

export enum STORE_NAME {
  META = 'IDBSideSync_MetaStore',
  OPLOG = 'IDBSideSync_OpLogStore',
}

export const OPLOG_STORE = STORE_NAME.OPLOG;
export const META_STORE = STORE_NAME.META;
export const OPLOG_INDEX = 'Indexed by: store, objectKey, prop, hlcTime';
export const CACHED_SETTINGS_OBJ_KEY = 'settings';
export const OPLOG_MERKLE_OBJ_KEY = 'oplogMerkle';

// This is technically unnecessary, but a nice way to help make sure we're always referencing a valid OpLogEntry
// property name when defining a `keyPath` for the object store.
const OPLOG_ENTRY_HLC_TIME_PROP_NAME: keyof OpLogEntry = 'hlcTime';

let cachedDb: IDBDatabase;
let cachedSettings: Settings;
let cachedMerkle: MerkleTree;

/**
 * This should be called as part of the upstream library handling an onupgradeneeded event (i.e., this won't be called
 * every time an app starts up--only when the database version changes).
 */
export function onupgradeneeded(event: IDBVersionChangeEvent): void {
  debug && log.debug('onupgradeneeded()');

  const db = (event.target as IDBOpenDBRequest).result;

  // Create an object store where we can put IDBSideSync settings that won't be sync'ed. Note the lack of a keypath.
  // This means that a "key" arg will need to be specified when calling `add()` or `put()`.
  db.createObjectStore(STORE_NAME.META);

  const oplogStore = db.createObjectStore(STORE_NAME.OPLOG, { keyPath: OPLOG_ENTRY_HLC_TIME_PROP_NAME });

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
  debug && log.debug('init()');
  if (!db || !db.createObjectStore) {
    throw new TypeError(`${libName}.init(): 'db' arg must be an instance of IDBDatabase.`);
  }
  cachedDb = db;
  const settings = await initSettings();
  HLClock.setTime(new HLTime(0, 0, settings.nodeId));
}

export function getSettings(): Settings {
  if (!cachedSettings) {
    throw new Error(`${libName} hasn't been initialized. Please call init() first.`);
  }
  return cachedSettings;
}

/**
 * Ensures that IDBSideSync has required settings in its own IndexedDB store (e.g., a unique node ID that identifies
 * all the oplog entries created by the application instance).
 */
export function initSettings(): Promise<typeof cachedSettings> {
  return new Promise((resolve, reject) => {
    const txReq = cachedDb.transaction([STORE_NAME.META], 'readwrite');
    txReq.onabort = () => reject(new TransactionAbortedError(txReq.error));
    txReq.onerror = (event) => {
      const error = isEventWithTargetError(event) ? event.target.error : txReq.error;
      log.error('Failed to init settings:', error);
      reject(new Error(`${libName} Failed to init settings`));
    };

    const metaStore = txReq.objectStore(STORE_NAME.META);
    const getReq = metaStore.get(CACHED_SETTINGS_OBJ_KEY);

    getReq.onsuccess = () => {
      const result = getReq.result;
      if (result && isValidSideSyncSettings(result)) {
        debug && log.debug(`Skipping settings initialization; existing settings found.`, result);
        cachedSettings = result;
        resolve(cachedSettings);
      } else {
        debug && log.debug('No valid settings found in database; initializing new settings...');
        cachedSettings = { nodeId: makeNodeId(), syncProfiles: [] };
        const putReq = metaStore.put(cachedSettings, CACHED_SETTINGS_OBJ_KEY);
        putReq.onsuccess = () => {
          debug && log.debug('Successfully saved initial settings:', cachedSettings);
          resolve(cachedSettings);
        };
      }
    };
  });
}

export function saveSettings(newSettings: Settings): Promise<Settings> {
  return new Promise((resolve, reject) => {
    const txReq = cachedDb.transaction([STORE_NAME.META], 'readwrite');
    txReq.onabort = () => reject(new TransactionAbortedError(txReq.error));
    txReq.onerror = (event) => {
      const error = isEventWithTargetError(event) ? event.target.error : txReq.error;
      log.error('Failed to save settings:', error);
      reject(new Error(`${libName} Failed to save settings`));
    };

    const metaStore = txReq.objectStore(STORE_NAME.META);
    const putReq = metaStore.put(newSettings, CACHED_SETTINGS_OBJ_KEY);
    putReq.onsuccess = () => {
      cachedSettings = newSettings;
      debug && log.debug('Successfully saved settings:', cachedSettings);
      resolve(cachedSettings);
    };
  });
}

export async function saveOplogMerkle(merkle: MerkleTree): Promise<void> {
  if (!cachedDb) {
    throw new Error(`${libName} hasn't been initialized. Please call init() first.`);
  }

  return new Promise((resolve, reject) => {
    const txReq = cachedDb.transaction([STORE_NAME.META], 'readwrite');
    txReq.onabort = () => reject(new TransactionAbortedError(txReq.error));
    txReq.onerror = (event) => {
      const error = isEventWithTargetError(event) ? event.target.error : txReq.error;
      const errMsg = `Error while attempting to save merkle tree to '${STORE_NAME.META}'`;
      log.error(errMsg, error);
      reject(new Error(`${libName} ${errMsg}`));
    };

    const metaStore = txReq.objectStore(STORE_NAME.META);
    const putReq = metaStore.put(merkle, OPLOG_MERKLE_OBJ_KEY);

    putReq.onsuccess = () => {
      cachedMerkle = merkle;
      debug && log.debug('Successfully saved merkle:', merkle);
      resolve();
    };
  });
}

export async function getOplogMerkleTree(): Promise<MerkleTree> {
  if (!cachedDb) {
    throw new Error(`${libName} hasn't been initialized. Please call init() first.`);
  }

  if (cachedMerkle) {
    log.debug('Returning cached merkle tree.');
    return Promise.resolve(cachedMerkle);
  }

  return new Promise((resolve, reject) => {
    const txReq = cachedDb.transaction([STORE_NAME.META], 'readwrite');
    txReq.onabort = () => reject(new TransactionAbortedError(txReq.error));
    txReq.onerror = (event) => {
      const error = isEventWithTargetError(event) ? event.target.error : txReq.error;
      const errMsg = `Error while attempting to load merkle tree from '${STORE_NAME.META}'`;
      log.error(errMsg, error);
      reject(new Error(`${libName} ${errMsg}`));
    };

    const metaStore = txReq.objectStore(STORE_NAME.META);
    const getReq = metaStore.get(OPLOG_MERKLE_OBJ_KEY);

    getReq.onsuccess = () => {
      const result = getReq.result;

      let newMerkle: MerkleTree = new MerkleTree();

      if (!result) {
        log.debug(`No existing merkle data in ${STORE_NAME.META}; creating new merkle tree.`);
      } else {
        try {
          debug && log.debug(`Attempting to parse merkle tree previously saved to ${STORE_NAME.META}.`);
          newMerkle = MerkleTree.fromObj(result);
        } catch (error) {
          log.warn(`Invalid merkle saved to ${STORE_NAME.META}; deleting saved data and using new merkle instead.`);
          metaStore.delete(OPLOG_MERKLE_OBJ_KEY).onsuccess = () => {
            debug && log.debug(`Successfully deleted invalid merkle from '${STORE_NAME.META}'`);
          };
        }
      }

      resolve(newMerkle);
    };
  });
}

export async function deleteOplogMerkle(): Promise<void> {
  if (!cachedDb) {
    throw new Error(`${libName} hasn't been initialized. Please call init() first.`);
  }

  await transaction(cachedDb, [STORE_NAME.META], 'readwrite', async (metaStore) => {
    metaStore.delete(OPLOG_MERKLE_OBJ_KEY).onsuccess = () => {
      debug && log.debug(`Successfully deleted merkle from '${STORE_NAME.META}/OPLOG_MERKLE_OBJ_KEY'`);
    };
  });
}

export async function updateOplogMerkle(merkle: MerkleTree): Promise<void> {
  let counter = 0;
  let startTime = performance.now();

  //TODO: get the right-most branch of the merkle tree, then get all local entries after that time
  for await (const oplogEntry of getEntries()) {
    merkle.insertHLTime(HLTime.parse(oplogEntry.hlcTime));
    counter++;
  }
  let stopTime = performance.now();
  log.debug(`⏱ Took ${stopTime - startTime}msec to add ${counter} entries to merkle tree.`);
}

/**
 * A convenience function that wraps the paginated results of `getEntriesPage()` and returns an async iteraterable
 * iterator so that you can do something like the following:
 *
 * @example
 * ```
 * for await (let entry of getEntries()) {
 *   await doSomethingAsyncWith(entry)
 * }
 * ```
 *
 * For more info on async generators, etc., see https://javascript.info/async-iterators-generators.
 */
export async function* getEntries(params: { afterTime?: Date | null } = {}): AsyncGenerator<OpLogEntry, void, void> {
  let page = 0;
  while (page >= 0) {
    const entries = await getEntriesPage({ afterTime: params.afterTime, page, pageSize: 100 });
    page = entries.length ? page + 1 : -1;
    for (const entry of entries) {
      yield entry;
    }
  }
}

/**
 * Use this function to retrieve paginated oplog entries from the IndexedDB object store.
 *
 * Pagination is used to eliminate the possibility of async operations being attempted during the IndexedDB transaction
 * used to retrieve the entries. Some number of objects are read from the database, the transaction finishes, and the
 * caller can take as much time as desired working on the returned set of entries before requesting another page.
 *
 * Note that the pagination algorithm is a modified version of an example shared by Raymond Camden at
 * https://www.raymondcamden.com/2016/09/02/pagination-and-indexeddb/.
 */
export function getEntriesPage(
  params: { afterTime?: Date | null; page: number; pageSize: number } = { page: 0, pageSize: 5 }
): Promise<OpLogEntry[]> {
  let startTime = performance.now();
  let query: IDBKeyRange | null = null;
  if (params?.afterTime instanceof Date) {
    // Set a lower bound for the cursor (e.g., "2021-03-01T20:33:14.080Z"). Keep in mind that the OpLogEntry store uses
    // each object's `.hlcTime` prop as the keyPath (e.g., "2021-02-08T11:01:15.142Z-0000-afd67a3799189eaa"). This means
    // that the objects are sorted by those strings. By specifying an ISO-formatted date string as the lower bound for
    // the cursor we are saying "move the cursor to the first key that is >= this string".
    query = IDBKeyRange.lowerBound(params.afterTime.toISOString());
  }

  return new Promise(function(resolve, reject) {
    const txReq = cachedDb.transaction([STORE_NAME.OPLOG], 'readonly');
    txReq.onabort = () => reject(new TransactionAbortedError(txReq.error));
    txReq.onerror = (event) => reject(isEventWithTargetError(event) ? event.target.error : txReq.error);

    const store = txReq.objectStore(STORE_NAME.OPLOG);

    if (store.keyPath !== OPLOG_ENTRY_HLC_TIME_PROP_NAME) {
      throw new Error(
        `${libName} getEntries() can't return oplog entries in reliable order; ${OPLOG_STORE} isn't using ` +
          `${OPLOG_ENTRY_HLC_TIME_PROP_NAME} as its keyPath and therefore entries aren't sorted by HLC time.`
      );
    }

    const cursorReq = store.openCursor(query);

    const entries: OpLogEntry[] = [];
    let cursorWasAdvanced = false;

    cursorReq.onsuccess = function() {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve(entries);
        return;
      }

      if (!cursorWasAdvanced && params.page > 0) {
        cursorWasAdvanced = true;
        cursor.advance(params.page * params.pageSize);
        return;
      }

      entries.push(cursor.value);

      if (entries.length < params.pageSize) {
        cursor.continue();
      } else {
        let stopTime = performance.now();
        log.debug(`⏱ Took ${stopTime - startTime}msec to get ${params.pageSize} entries at page ${params.page}.`);
        resolve(entries);
      }
    };
  });
}

export async function applyOplogEntries(candidates: OpLogEntry[]) {
  for (const candidate of candidates) {
    await applyOplogEntry(candidate);
  }
}

/**
 * Attempt to apply an oplog entry to a specified store + objectKey + prop. In other words, update an existing object in
 * the appropriate object store, or create a new one, per the _operation_ represented by an oplog entry object. Then add
 * the entry to the local oplog entries store.
 *
 * If the referenced objectKey + prop already exists, it will only be updated if the oplog entry is the most recent one
 * we know about for that store + objectKey + prop. If an oplog entry with a more recent `hlcTime` is found in the local
 * oplog store, the passed-in entry will not be applied or added to the local oplog store.
 *
 * Important: all of the IndexedDB operations performed by this function should happen in the same transaction. This
 * ensures that, if any one of those operations fails, the transaction can be aborted and none of the operations will
 * persist.
 */
export function applyOplogEntry(candidate: OpLogEntry) {
  return new Promise((resolve, reject) => {
    try {
      throwIfInvalidOpLogEntry(candidate);
    } catch (error) {
      reject(new InvalidOpLogEntryError(candidate, error.message));
    }

    let candidateHLTime;
    try {
      candidateHLTime = HLTime.parse(candidate.hlcTime);
    } catch (error) {
      reject(new InvalidOpLogEntryError(candidate, error.message));
    }

    // This logic is redundant since throwIfInvalidOpLogEntry() validates the hlcTime, but necessary to prove to the
    // Typescript compiler that candidateHLTime is set to a value.
    if (!candidateHLTime) {
      return;
    } else if (candidateHLTime.node() === HLClock.time().node()) {
      log.warn(`Encountered oplog entry with the same node ID:`, candidateHLTime.node());
    }

    // Ensure that our HLClock is set to a time that occurs after any other time we encounter (even if we end up not
    // applying the oplog entry).
    const currentHLTime = HLClock.time().toString();
    if (candidateHLTime.toString() > currentHLTime) {
      debug &&
        log.debug(`Encountered oplog entry with more recent HLTime; updating time.`, {
          currentTime: currentHLTime,
          oplogEntryTime: candidate.hlcTime,
        });

      // Note that this will throw if the oplog entry's time is too far in the future...
      HLClock.tickPast(candidateHLTime);

      debug &&
        log.debug(`Updated local HL time.`, {
          previousTime: currentHLTime,
          currentTime: HLClock.time().toString(),
        });
    }

    const txReq = cachedDb.transaction([STORE_NAME.OPLOG, candidate.store], 'readwrite');
    txReq.oncomplete = () => resolve(txReq);
    txReq.onabort = () => reject(new TransactionAbortedError(txReq.error));
    txReq.onerror = (event) => reject(isEventWithTargetError(event) ? event.target.error : txReq.error);

    const oplogStore = txReq.objectStore(STORE_NAME.OPLOG);
    const targetStore = txReq.objectStore(candidate.store);
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
        try {
          throwIfInvalidOpLogEntry(cursor.value);
        } catch (error) {
          log.warn(
            `encountered an invalid oplog entry in "${OPLOG_STORE}" store. This might mean that an oplog entry` +
              `was manually edited or created in an invalid way somewhere. The entry will be ignored.`,
            JSON.stringify(error.message)
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
          txReq.abort();
          // By calling reject() here we are preventing txReq.onabort or txReq.onerror from rejecting; this allows
          // the calling code to catch our custom error vs. a generic the DOMException from IDB
          reject(new UnexpectedOpLogEntryError('store', candidate.store, existing.store));
        } else if (expectedObjectKey !== actualObjectKey) {
          txReq.abort();
          reject(new UnexpectedOpLogEntryError('objectKey', expectedObjectKey, actualObjectKey));
        } else if (existing.prop !== candidate.prop) {
          txReq.abort();
          reject(new UnexpectedOpLogEntryError('prop', candidate.prop, cursor.value.prop));
        }

        // If we found an existing entry whose HLC timestamp is more recent than the candidate's, then the candidate
        // entry is obsolete and we'll ignore it.
        if (candidate.hlcTime < existing.hlcTime) {
          debug && log.debug(`WON'T apply oplog entry; found existing that's newer:`, { candidate, existing });
          return;
        }
      }

      // If the thread of execution makes it this far, it means we didn't find an existing entry with a newer timestamp.
      log.debug(`applying oplog entry; didn't find a newer one with matching store/key/prop.`);

      // Add the entry to the oplog store. Note that, in theory, it may already exist there (e.g., it's possible for a
      // sync to happen in which known oplog entries received again). Instead of attempting to check first, we'll just
      // use `put()` to "upsert"--less code and avoids an extra IndexedDB operation.
      const oplogPutReq = oplogStore.put(candidate);

      if (process.env.NODE_ENV !== 'production') {
        oplogPutReq.onsuccess = () => {
          debug && log.debug(`successfully added oplog entry to "${OPLOG_STORE}".`, candidate);
        };
      }

      oplogPutReq.onerror = (event) => {
        const errMsg = `${libName} encountered an error while attempting to add an object to "${OPLOG_STORE}".`;
        log.error(errMsg, event);
        // By calling reject() here we are preventing txReq.onabort or txReq.onerror from rejecting; this allows
        // the calling code to catch our custom error vs. a generic the DOMException from IDB
        reject(new Error(errMsg));
      };

      const existingObjReq = targetStore.get(candidate.objectKey);

      existingObjReq.onsuccess = () => {
        const existingValue = existingObjReq.result;

        if (existingValue) {
          debug && log.debug(`retrieved existing object from "${candidate.store}":`, existingValue);
        } else {
          debug && log.debug(`no existing object found in "${candidate.store}" with key: ${candidate.objectKey}`);
        }

        let newValue: any;

        if (candidate.prop === '') {
          // If the OpLogEntry doesn't reference an _object property_, then we're not setting a prop on an object; the
          // candidate value _is_ the new value.
          newValue = candidate.value;
        } else if (existingValue && typeof existingValue === 'object') {
          // "Merge" the existing object with the new object.
          newValue = { ...existingValue, [candidate.prop]: candidate.value };
        } else {
          // No existing value exists. Since the oplog entry specifies an _object property_ (i.e., candidate.prop), we
          // know that the final value needs to be an object.
          newValue = { [candidate.prop]: candidate.value };

          // Ensure that the new value object we just created has the required keyPath props if necessary
          if (targetStore.keyPath) {
            if (Array.isArray(targetStore.keyPath)) {
              if (Array.isArray(candidate.objectKey)) {
                for (let i = 0; i < targetStore.keyPath.length; i++) {
                  const keyProp = targetStore.keyPath[i];
                  newValue[keyProp] = candidate.objectKey[i];
                }
              } else {
                const putError = new ApplyPutError(
                  targetStore.name,
                  `The oplog entry's ".objectKey" property should be an array but isn't: ` + JSON.stringify(candidate)
                );
                log.error(putError);
                txReq.abort();
                // By calling reject() here we are preventing txReq.onabort or txReq.onerror from rejecting; this allows
                // the calling code to catch our custom error vs. a generic the DOMException from IDB
                reject(putError);
                return;
              }
            } else {
              newValue[targetStore.keyPath] = candidate.objectKey;
            }
          }
        }

        let mergedPutReq: IDBRequest;

        try {
          // When calling the target object store's `put()` method it's important to NOT include a `key` param if that
          // store has a `keyPath`. Doing this causes an error (e.g., "[...] object store uses in-line keys and the key
          // parameter was provided" in Chrome).
          mergedPutReq = targetStore.keyPath
            ? targetStore.put(newValue)
            : targetStore.put(newValue, candidate.objectKey);
        } catch (error) {
          const putError = new ApplyPutError(targetStore.name, error);
          log.error(putError, error);
          txReq.abort();
          // By calling reject() here we are preventing txReq.onabort or txReq.onerror from rejecting; this allows
          // the calling code to catch our custom error vs. a generic the DOMException from IDB
          reject(putError);
          return;
        }

        mergedPutReq.onerror = (event) => {
          const error = isEventWithTargetError(event) ? event.target.error : mergedPutReq.error;
          const putError = new ApplyPutError(targetStore.name, error);
          log.error(putError);
          // By calling reject() here we are preventing txReq.onabort or txReq.onerror from rejecting; this allows
          // the calling code to catch our custom error vs. a generic the DOMException from IDB
          reject(putError);
        };

        if (debug) {
          mergedPutReq.onsuccess = () => {
            log.debug(`successfully applied oplog entry to ${targetStore.name}.`, {
              existingValue,
              newValue,
            });
          };
        }
      };

      existingObjReq.onerror = (event) => {
        const errMsg =
          `${libName} encountered an error while trying to retrieve an object from "${targetStore.name}"  as part ` +
          `of applying an oplog entry change to that object.`;
        log.error(errMsg, event);
        reject(new Error(errMsg));
      };
    };

    idxCursorReq.onerror = (event) => {
      const errMsg = `${libName} encountered an error while trying to open a cursor on the "${OPLOG_INDEX}" index.`;
      log.error(errMsg, event);
      reject(new Error(errMsg));
    };
  });
}

class UnexpectedOpLogEntryError extends Error {
  constructor(noun: keyof OpLogEntry, expected: string, actual: string) {
    super(
      `${libName}: invalid "most recent oplog entry"; expected '${noun}' value of '${expected}' but got ` +
        `'${actual}'. (This might mean there's a problem with the IDBKeyRange used to iterate over ${OPLOG_INDEX}.)`
    );
    Object.setPrototypeOf(this, UnexpectedOpLogEntryError.prototype); // https://git.io/vHLlu
  }
}

export class ApplyPutError extends Error {
  constructor(storeName: string, error: unknown) {
    super(`${libName}: error on attempt to apply oplog entry that adds/updates object in "${storeName}": ` + error);
    Object.setPrototypeOf(this, ApplyPutError.prototype); // https://git.io/vHLlu
  }
}

export class TransactionAbortedError extends Error {
  constructor(error: unknown) {
    super(`${libName}: transaction aborted with error: ` + error);
    Object.setPrototypeOf(this, TransactionAbortedError.prototype); // https://git.io/vHLlu
  }
}

export class InvalidOpLogEntryError extends Error {
  constructor(object: unknown, message = '') {
    super(`Object is not a valid OpLogEntry; ${message}: ` + JSON.stringify(object));
    Object.setPrototypeOf(this, InvalidOpLogEntryError.prototype); // https://git.io/vHLlu
  }
}
