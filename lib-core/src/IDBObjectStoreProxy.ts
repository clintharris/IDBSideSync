import { STORE_NAME } from './db';
import { HLClock } from './HLClock';
import { proxyPutRequest } from './IDBUpsertRequestProxy';

export function proxyStore(target: IDBObjectStore): IDBObjectStore {
  const storeNames = target.transaction.objectStoreNames;
  if (storeNames && !storeNames.contains(STORE_NAME.OPLOG)) {
    throw new Error(`Transaction was opened without including IDBSideSync.OPLOG_STORE as one of the stores.`);
  }
  const proxy = new IDBObjectStoreProxy(target);
  return new Proxy(target, proxy);
}

export class IDBObjectStoreProxy {
  target: IDBObjectStore;

  constructor(target: IDBObjectStore) {
    if (target.autoIncrement) {
      // If the store has autoIncrement enabled, then it's possible for different nodes to create objects with the same
      // keys. In that scenario, there's no safe way to share and apply oplog entries (i.e., CRDT messages) since they
      // might describe mutations that _appear_ to be relevant to the same object but actually could refer to different
      // objects that have the same key/ID.
      throw new Error(`IDBSideSync can't work with object stores whose .autoIncrement property is set to true.`);
    } else if (target.keyPath) {
      for (const keyPath of Array.isArray(target.keyPath) ? target.keyPath : [target.keyPath]) {
        if (keyPath.includes('.')) {
          throw new Error(
            `IDBSideSync doesn't support stores with a nested keyPath values (i.e., keyPath with dot-notation strings)`
          );
        }
      }
    }

    this.target = target;
  }

  get(target: IDBObjectStore, prop: keyof IDBObjectStore, receiver: unknown) {
    this.target = target;

    if (prop === 'add') {
      return this.proxiedAdd;
    } else if (prop === 'put') {
      return this.proxiedPut;
    } else if (prop === 'get') {
      // We have explicitly bind some fcn properties to the target before returning them to prevent some weird errors
      return this.target.get.bind(this.target);
    } else if (prop === 'getAll') {
      // We have explicitly bind some fcn properties to the target before returning them to prevent some weird errors
      return this.target.getAll.bind(this.target);
    } else if (prop === 'index') {
      // We have explicitly bind some fcn properties to the target before returning them to prevent some weird errors
      return this.target.index.bind(this.target);
    }

    return Reflect.get(target, prop, receiver);
  }

  proxiedAdd = (value: any, key?: IDBValidKey): ReturnType<IDBObjectStore['add']> => {
    if (!this.target.keyPath && !key) {
      this.target.transaction.abort();
      throw new MissingKeyParamError('add');
    }

    try {
      this.recordOperation(value, key);
    } catch (error) {
      this.target.transaction.abort();
      throw error;
    }

    return this.target.add(value, key);
  };

  proxiedPut = (value: any, key?: IDBValidKey): ReturnType<IDBObjectStore['put']> => {
    const keyPath = this.target.keyPath;

    if (!keyPath && !key) {
      this.target.transaction.abort();
      throw new MissingKeyParamError('put');
    }

    try {
      this.recordOperation(value, key);
    } catch (error) {
      this.target.transaction.abort();
      throw error;
    }

    const existingObjKey = resolveKey(this.target, value, key);
    const existingObjReq = this.target.get(existingObjKey);

    let tempPutCompleted = false;

    existingObjReq.onsuccess = () => {
      // Figure out what the new value for the object will be--either a merger of its existing props with new ones (in
      // the case that it's an object), or a new primitive value (e.g., you can't merge numbers, dates, etc.).
      //
      // Note that this operation does not involve checking the collection of oplog entries to see if newer values
      // exist. That's only a concern when 1+ oplog entries are being applied outside of normal application CRUD calls
      // on a proxied object store. In other words, it's assumed that when an application calls `store.put()`, the
      // passed-in value is most recent known value at that point in time--there is no need to check for a newer value.
      // The concern with ensuring that an "old" oplog entry is not used to set a value when a NEWER oplog entry for the
      // same field exists only applies to syncing.
      const resolvedValue =
        value && typeof value === 'object' && existingObjReq.result && typeof existingObjReq.result === 'object'
          ? { ...existingObjReq.result, ...value } // "Merge" the new object with the existing object
          : value;

      try {
        const mergedPutReq = keyPath ? this.target.put(resolvedValue) : this.target.put(resolvedValue, key);

        mergedPutReq.onsuccess = () => {
          // This is sort of a crude way of trying to verify that `mergedPutReq` finishes last (i.e., the "merged" value
          // of the object is what ends up being persisted when the transaction is complete).
          if (!tempPutCompleted) {
            throw new Error(`IDBSideSync: "final" put() with merged value ran BEFORE the "temp" put.`);
          }
        };
      } catch (error) {
        throw new FinalPutError(this.target.name, error);
      }
    };

    let tempValue = value;

    // Ensure that the object has all the properties it needs, per the store's `keyPath`. If it doesn't, try to get
    // them from the `key` arg.
    if (keyPath) {
      tempValue = { ...value };
      if (Array.isArray(keyPath)) {
        for (let i = 0; i < keyPath.length; i++) {
          const keyProp = keyPath[i];
          if (!(keyProp in tempValue) || tempValue[keyProp] === undefined) {
            if (!key) {
              throw new PutWithoutKeyError(this.target);
            } else if (!Array.isArray(key)) {
              throw new Error(`IDBSideSync: The "key" passed to "store.put(obj, key)" should be an array.`);
            }
            tempValue[keyProp] = key[i];
          }
        }
      } else if (!(keyPath in tempValue)) {
        if (!key) {
          throw new PutWithoutKeyError(this.target);
        }
        tempValue[keyPath] = key;
      }
    }

    try {
      // The call to `put()` below is "temporary" and it's assumed that the additional call to `put()` above will always
      // run LAST (i.e., ensuring that the call to `put()` with the MERGED values will "win" when the transaction is
      // resolved and committed).
      //
      // This approach of calling put() below just so a valid IDBRequest can be returned, then calling it again later
      // with the merged values seems...hacky. It has been observed to work in different browsers through testing, but
      // the actual IndexedDB implementations and spec haven't been studied to completely guarantee that the transaction
      // will _always_ resolve/commit in the order that we want (and have observed so far).
      //
      // If at some point issues are found with how final the final value is resolved when the transaction is committed,
      // another solution will be needed. For example, maybe some sort of "manually-built", totally synthetic object
      // that implements the IDBRequest<IDBValidKey> interface is returned below. Returning a fake request seems like it
      // could be tricky and include its own hacky baggage, however; we'll stick with the current approach (which seems
      // to work) for now.
      //
      // When calling the actual object store's `put()` method it's important to NOT include a `key` param if the store
      // has a `keyPath`. Doing so would cause an error (e.g., "[...] object store uses in-line keys and the key
      // parameter was provided" in Chrome).
      const tempPutReq = keyPath ? this.target.put(tempValue) : this.target.put(tempValue, key);

      const proxyPutReq = proxyPutRequest(tempPutReq, {
        onSuccess: () => {
          tempPutCompleted = true;
        },
        onError: () => {
          this.target.transaction.abort();
          throw new TempPutError(this.target.name, proxyPutReq.error);
        },
      });
      return proxyPutReq;
    } catch (error) {
      this.target.transaction.abort();
      throw new TempPutError(this.target.name, error);
    }
  };

  /**
   * This method is used to convert an object that was just "put" into an object store into 1+ oplog entries that can be
   * recorded and shared so the operation can be replicated on other nodes. It should be called as part of the same
   * transaction used to perform the actual add()/put() so that if operation fails--or if the attempt to add an object
   * to the oplog store fails--all of the operations are rolled back.
   *
   * The optional `key` arg should only exist if the proxied object store was created without a `keyPath`. For a nice
   * summary of possible `keyPath` and `autoIncrement` permutations, and what that means for the object store, see
   * https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB#Structuring_the_database.
   *
   * Note that we're declaring it as a class property initialized to an arrow function to ensure that `this` will
   * resolve correctly (an alternative to re-binding a class method to `this` in the constructor).
   */
  recordOperation = (newValue: any, key?: IDBValidKey) => {
    if (key instanceof ArrayBuffer || key instanceof DataView) {
      throw new TypeError(`Keys of type ArrayBuffer or DataView aren't currently supported.`);
    } else if (Array.isArray(key)) {
      const foundArrBuffItem = key.find(() => key instanceof ArrayBuffer || key instanceof DataView);
      if (foundArrBuffItem) {
        throw new TypeError(`Keys of type ArrayBuffer or DataView aren't currently supported.`);
      }
    }

    let objectKey;
    try {
      objectKey = resolveKey(this.target, newValue, key);
    } catch (error) {
      if (error instanceof UnknownObjectKeyError) {
        if (this.target.keyPath) {
          throw new PutWithoutKeyError(this.target);
        } else {
          throw new MissingKeyParamError('add or put');
        }
      }
      throw error;
    }

    let entries: OpLogEntry[] = [];

    if (typeof newValue === 'object') {
      // Convert each property in the `value` to an OpLogEntry.
      for (const property in newValue) {
        entries.push({
          hlcTime: HLClock.tick().toString(),
          store: this.target.name,
          objectKey: objectKey,
          prop: property,
          value: newValue[property],
        });
      }
    } else {
      // It's possible to store non-object primitives in an object store, too (e.g., `store.put(true, "someKey")`).
      entries.push({
        hlcTime: HLClock.tick().toString(),
        store: this.target.name,
        objectKey: objectKey,
        // If a non-object/primitive is being updated, then there isn't a property that's being updated--we're just
        // setting some key to a value--so there isn't a `prop`. We can't use `prop: null`, however; this causes an
        // error because `prop` is one of the properties in the oplog store's `keyPath` and IndexedDB doesn't allow
        // null, undefined, or boolean values to be used as keys.
        prop: '',
        value: newValue,
      });
    }

    let oplogStore;
    try {
      // When getting a reference to our own object store where the operation will be recorded, it's important that we
      // reuse the existing transaction. By doing so, both recording the operation and performing the operation are part
      // of the same transaction; we can ensure that if anything fails for some reason, nothing will be persisted.
      oplogStore = this.target.transaction.objectStore(STORE_NAME.OPLOG);
    } catch (error) {
      const errorMsg =
        `IDBSideSync: Error ocurred when attempting to get reference to the "${STORE_NAME.OPLOG}" store (this may ` +
        `have happened because "${STORE_NAME.OPLOG}" wasn't included when the transaction was created): ` +
        error.toString();
      throw new Error(errorMsg);
    }

    for (const entry of entries) {
      oplogStore.add(entry);
    }
  };
}

/**
 * A utility function for deriving a key value that can be used to retrieve an object from an IDBObjectStore.
 */
export function resolveKey(store: IDBObjectStore, value: any, key?: IDBValidKey) {
  let resolvedKey;

  if (key) {
    resolvedKey = key;
  } else if (Array.isArray(store.keyPath)) {
    resolvedKey = store.keyPath.map((keyProp) => value[keyProp]);
  } else if (store.keyPath) {
    resolvedKey = value[store.keyPath];
  }

  if (!resolvedKey || (Array.isArray(resolvedKey) && resolvedKey.length === 0)) {
    throw new UnknownObjectKeyError();
  }
  return resolvedKey;
}

export class PutWithoutKeyError extends Error {
  constructor(store: IDBObjectStore) {
    let formattedKeyNames = Array.isArray(store.keyPath) ? store.keyPath.join('", "') : `"${store.keyPath}"`;
    super(
      `IDBSideSync: The object passed to ${store.name}.put(...) lacks properties from ${store.name}.keyPath and no ` +
        `"key" arg was specified. Either call put() with a key arg (e.g., store.put(obj, key)) or make sure the ` +
        `object has the following properties set to valid values: ${formattedKeyNames}`
    );
    Object.setPrototypeOf(this, PutWithoutKeyError.prototype); // https://preview.tinyurl.com/y4jhzjgs
  }
}

export class TempPutError extends Error {
  constructor(storeName: string, error: unknown) {
    super(`IDBSideSync: error while attempting to "temporarily" put() something into "${storeName}": ` + error);
    Object.setPrototypeOf(this, TempPutError.prototype); // https://preview.tinyurl.com/y4jhzjgs
  }
}

export class FinalPutError extends Error {
  constructor(storeName: string, error: unknown) {
    super(`IDBSideSync: error while attempting to put() final/merged version of object into "${storeName}": ` + error);
    Object.setPrototypeOf(this, FinalPutError.prototype); // https://preview.tinyurl.com/y4jhzjgs
  }
}

export class MissingKeyParamError extends Error {
  constructor(fcnName: string) {
    super(`IDBSideSync: You must specify the "key" param when calling ${fcnName}() on a store without a keyPath.`);
    Object.setPrototypeOf(this, MissingKeyParamError.prototype); // https://preview.tinyurl.com/y4jhzjgs
  }
}

export class UnknownObjectKeyError extends Error {
  constructor() {
    super(`IDBSideSync: failed to establish a key for retrieving object before updating it.'`);
    Object.setPrototypeOf(this, UnknownObjectKeyError.prototype); // https://preview.tinyurl.com/y4jhzjgs
  }
}
