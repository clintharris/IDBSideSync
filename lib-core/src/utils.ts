import { v4 as uuid } from 'uuid';
import { HLTime } from './HLTime';

export { v4 as uuid } from 'uuid';

export const libName = 'IDBSideSync';
export let debug = process.env.NODE_ENV !== 'production';
export function setDebug(isEnabled: boolean) {
  debug = isEnabled === true;
}

export function noOp() {}

/**
 * Use this function to create a presumably unique string that can be used to identify a client/node/agent. This just
 * uses the last 16 chars of a UUID (e.g., `37c2877f-fbf4-40f3-bdb7-87f4536dc989` => `bdb787f4536dc989`);
 *
 * @returns a 16-char, presumably-unique string.
 */
export function makeNodeId(): string {
  return uuid()
    .replace(/-/g, '')
    .slice(-16); // TODO: Figure out if there's a reason for using last 16 chars, specifically.
}

/**
 * Utility / type guard function for verifying that something is both a valid IDB object key and a key supported by
 * IDBSideSync.
 */
export function isSupportedObjectKey(thing: unknown): thing is IDBValidKey {
  const thingType = typeof thing;

  //TODO https://github.com/clintharris/IDBSideSync/issues/1
  if (thingType === 'string' || thingType === 'number') {
    return true;
  }

  if (Array.isArray(thing)) {
    for (const item of thing) {
      if (!isSupportedObjectKey(item)) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Type guard for safely asserting that something is an OpLogEntry.
 */
export function isValidOplogEntry(thing: unknown): thing is OpLogEntry {
  if (!thing) {
    return false;
  }

  const candidate = thing as OpLogEntry;

  if (typeof candidate.store !== 'string' || candidate.store.trim() === '') {
    return false;
  }

  if (typeof candidate.prop !== 'string') {
    return false;
  }

  if (!('value' in candidate)) {
    return false;
  }

  if (!HLTime.parse(candidate.hlcTime)) {
    return false;
  }

  if (!isSupportedObjectKey(candidate.objectKey)) {
    return false;
  }

  return true;
}

export function isValidSideSyncSettings(thing: unknown): thing is Settings {
  if (!thing) {
    return false;
  }

  const candidate = thing as Settings;

  if (typeof candidate.nodeId !== 'string') {
    return false;
  }

  return true;
}

interface EventTargetWithError extends EventTarget {
  error?: DOMException;
}

interface EventWithTargetError extends Event {
  readonly target: EventTargetWithError;
}

export function isEventWithTargetError(thing: unknown): thing is EventWithTargetError {
  if (!thing) {
    return false;
  }

  const candidate = thing as EventWithTargetError;

  if (candidate.target === null || candidate.target === undefined || typeof candidate.target !== 'object') {
    return false;
  }

  if (!('error' in candidate.target)) {
    return false;
  }

  return true;
}

/* eslint-disable no-console */
export const logPrefix = '[' + libName + ']';
export const log = {
  log: console.log.bind(console, logPrefix),
  debug: debug ? console.log.bind(console, logPrefix) : noOp,
  warn: console.warn.bind(console, logPrefix),
  error: console.error.bind(console, logPrefix),
};
/* eslint-enable no-console */

/**
 * Utility function for wrapping an IDB request with a promise so that the result/error can be `await`ed.
 *
 * @returns a promise that resolves (or throws) when the request's onsuccess/onerror callback runs.
 */
export function request(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Utility function for initiating an IndexedDB transaction, getting a reference to an object store, and being able to
 * `await` the completion of the transaction. Sort of a lightweight alternative to Jake Archibald's `idb` library.
 * Initially copied from his `svgomg` app (https://preview.tinyurl.com/yaoxc9cl) but adds the ability await the
 * completion of an async callback.
 *
 * @example
 * ```
 * let thing1;
 * let thing2;
 *
 * await transaction(db, ['myStore1', 'myStore2'], 'readwrite', async (myStore1, mystore2) => {
 *    thing1 = await resolveRequest(myStore1.get(111));
 *    thing2 = await resolveRequest(myStore2.get(222));
 * }
 *
 * // Do stuff with thing1 and thing2...
 * ```
 *
 * @return a Promise that resolves after both the passed-in 'callback' resolves AND the transaction 'oncomplete' fires.
 */
export async function transaction(
  db: IDBDatabase,
  storeNames: string[],
  mode: Exclude<IDBTransactionMode, 'versionchange'>,
  callback: (...stores: IDBObjectStore[]) => Promise<void>
): Promise<unknown> {
  const txReq = db.transaction(storeNames, mode);
  const stores = storeNames.map((storeName) => txReq.objectStore(storeName));

  const transactionCompletePromise = new Promise((resolve, reject) => {
    txReq.oncomplete = () => resolve(txReq);
    txReq.onabort = () => reject(new Error('Transaction aborted.'));
    txReq.onerror = (event) => reject(isEventWithTargetError(event) ? event.target.error : txReq.error);
  });

  // Return a promise that won't resolve until both the callback() and transaction have resolved/completed. Note that
  // callback() doesn't *have* to return a promise. Also note that Promise.all() will reject immediately upon any of the
  // input promises rejecting.
  return Promise.all([callback(...stores), transactionCompletePromise]);
}
