import { v4 as uuid } from 'uuid';
import { HLTime } from './HLTime';

export { v4 as uuid } from 'uuid';

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
 * Type guard for safely asserting that something is an OpLogEntry.
 */
export function isValidOplogEntry(thing: unknown): thing is OpLogEntry {
  if (!thing) {
    return false;
  }

  const candidate = thing as OpLogEntry;

  if (
    typeof candidate.hlcTime !== 'string' ||
    typeof candidate.store !== 'string' ||
    typeof candidate.objectKey !== 'string' ||
    (typeof candidate.prop !== 'string' && candidate.prop !== null) ||
    !('value' in candidate)
  ) {
    return false;
  }

  if (!HLTime.parse(candidate.hlcTime)) {
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

export const log = {
  warn(message: string, ...args: unknown[]): void {
    console.warn('[IDBSideSync:warn] ' + message, ...args);
  },

  error(message: string, ...args: unknown[]): void {
    console.error('[IDBSideSync:error] ' + message, ...args);
  },

  debug(message: string, ...args: unknown[]): void {
    if (process.env.NODE_ENV !== 'production') {
      console.log('[IDBSideSync:debug] ' + message, ...args);
    }
  },
};

/**
 * Utility function for wrapping an IDB request with a promise so that the result/error can be `await`ed.
 *
 * @returns a promise that resolves (or throws) when the request's onsuccess/onerror callback runs.
 */
export function request(request: IDBRequest) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => {
      // @ts-ignore
      reject(event.target.error);
    };
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
    txReq.oncomplete = () => {
      resolve(txReq);
    };
    txReq.onabort = () => reject(new Error('Transaction aborted.'));
    txReq.onerror = (event) => {
      // @ts-ignore
      reject(event.target.error);
    };
  });

  // Return a promise that won't resolve until both the callback() and transaction have resolved/completed. Note that
  // callback() doesn't *have* to return a promise (e.g., it's possible that the callback won't be declared as "async";
  // you can pass non-promises to Promise.all().
  return Promise.all([callback(...stores), transactionCompletePromise]);
}
