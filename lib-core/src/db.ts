/// <reference types="../../types/common" />

import { HLClock } from './HLClock';
import { HLTime } from './HLTime';
import {
  debug,
  isEventWithTargetError,
  isValidOplogEntry,
  isValidSideSyncSettings,
  libName,
  log,
  makeNodeId,
} from './utils';

export enum STORE_NAME {
  META = 'IDBSideSync_MetaStore',
  OPLOG = 'IDBSideSync_OpLogStore',
}

export const OPLOG_STORE = STORE_NAME.OPLOG;
export const OPLOG_INDEX = 'Indexed by: store, objectKey, prop, hlcTime';
export const CACHED_SETTINGS_OBJ_KEY = 'settings';

let cachedDb: IDBDatabase;
let cachedSettings: Settings;

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
  debug && log.debug('init()');
  if (!db || !db.createObjectStore) {
    throw new TypeError(`${libName}.init(): 'db' arg must be an instance of IDBDatabase.`);
  }
  cachedDb = db;
  const settings = await initSettings();
  HLClock.setTime(new HLTime(0, 0, settings.nodeId));
}

/**
 * Ensures that IDBSideSync has required settings in its own IndexedDB store (e.g., a unique node ID that identifies
 * all the oplog entries created by the application instance).
 */
export function initSettings(): Promise<typeof cachedSettings> {
  return new Promise((resolve, reject) => {
    const txReq = cachedDb.transaction([STORE_NAME.META], 'readwrite');
    txReq.oncomplete = () => resolve(cachedSettings);
    txReq.onabort = () => reject(new TransactionAbortedError(txReq.error));
    txReq.onerror = () => reject(txReq.error);

    const metaStore = txReq.objectStore(STORE_NAME.META);
    const getReq = metaStore.get(CACHED_SETTINGS_OBJ_KEY);

    getReq.onsuccess = () => {
      const result = getReq.result;
      if (result && isValidSideSyncSettings(result)) {
        debug && log.debug('found saved settings.', result);
        cachedSettings = result;
      } else {
        debug && log.debug('no valid settings found in database; creating new settings...');
        cachedSettings = { nodeId: makeNodeId() };
        const putReq = metaStore.put(cachedSettings, CACHED_SETTINGS_OBJ_KEY);
        putReq.onsuccess = () => {
          debug && log.debug('successfully persisted initial settings:', cachedSettings);
        };
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
        if (!isValidOplogEntry(cursor.value)) {
          log.warn(
            `encountered an invalid oplog entry in its "${OPLOG_STORE}" store. This might mean that an oplog entry` +
              `was manually edited or created in an invalid way somewhere. The entry will be ignored.`,
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

        const newValue =
          existingValue && typeof existingValue === 'object' && candidate.prop !== ''
            ? { ...existingValue, [candidate.prop]: candidate.value } // "Merge" the new object with the existing object
            : candidate.value;

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
    Object.setPrototypeOf(this, UnexpectedOpLogEntryError.prototype); // https://preview.tinyurl.com/y4jhzjgs
  }
}

export class ApplyPutError extends Error {
  constructor(storeName: string, error: unknown) {
    super(`${libName}: error on attempt to apply oplog entry that adds/updates object in "${storeName}": ` + error);
    Object.setPrototypeOf(this, ApplyPutError.prototype); // https://preview.tinyurl.com/y4jhzjgs
  }
}

export class TransactionAbortedError extends Error {
  constructor(error: unknown) {
    super(`${libName}: transaction aborted with error: ` + error);
    Object.setPrototypeOf(this, TransactionAbortedError.prototype); // https://preview.tinyurl.com/y4jhzjgs
  }
}
