import { STORE_NAME } from './db';
import { HLClock } from './HLClock';

export const SOFT_DELETED_PROP = 'IDBSideSync_SoftDeleted';

/**
 * Objects that have been "soft deleted" will a special property that indicates if they have been deleted.
 */
export interface ThingWithDeletedProp {
  [SOFT_DELETED_PROP]: boolean;
}

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
      return this.proxiedGet;
    } else if (prop === 'getAll') {
      return this.proxiedGetAll;
    } else if (prop === 'delete') {
      return this.proxiedDelete;
    }

    return Reflect.get(target, prop, receiver);
  }

  proxiedAdd = (...args: Parameters<IDBObjectStore['add']>): ReturnType<IDBObjectStore['add']> => {
    this.recordOperation(...args);
    return this.target.add(...args);
  };

  proxiedPut = (value: any, key?: IDBValidKey): ReturnType<IDBObjectStore['put']> => {
    this.recordOperation(value, key);

    const existingObjKey = resolveKey(this.target, value, key);
    const existingObjReq = this.target.get(existingObjKey);

    let putWithMergedValuesRan = false;

    existingObjReq.onsuccess = () => {
      const resolvedValue =
        value && typeof value === 'object' && existingObjReq.result && typeof existingObjReq.result === 'object'
          ? { ...existingObjReq.result, ...value } // "Merge" the new object with the existing object
          : value;
      this.target.keyPath ? this.target.put(resolvedValue) : this.target.put(resolvedValue, key);
      putWithMergedValuesRan = true;
    };

    // The call to `put()` _below_ is "temporary" and it's assumed that the additional call to `put()` _above_ will
    // always run LAST. This is because the `value` param passed to the "temporary" put() _below_ may be incomplete
    // (since IDBSideSync assumes that the `value` param being passed to `proxiedPut()` only containing properties for
    // the specific props that should be updated--not a completely new version of the object).
    //
    // The current approach of calling put() immediately just so a valid IDBRequest can be returned, then calling it
    // again later with the merged values seems to be working, but we'll still do a quick check to verify the order of
    // the calls. If it turns out that this order doesn't work in some cases, another solution will be needed (e.g.,
    // returning some sort of manually-built, fake IDBRequest object).
    if (putWithMergedValuesRan) {
      throw new Error(`IDBSideSync: put() with merged value ran before the "temp" put with incomplete value.`);
    }

    // When calling the actual object store's `put()` method it's important to NOT include a `key` param if the store
    // has a `keyPath`. Doing this causes an error (e.g., "[...] object store uses in-line keys and the key parameter
    // was provided" in Chrome).
    return this.target.keyPath ? this.target.put(value) : this.target.put(value, key);
  };

  proxiedDelete = (key: IDBValidKey | IDBKeyRange) => {
    if (key instanceof IDBKeyRange) {
      //TODO: Use the key range to open a cursor iterating over objects that match the key range, then update each one
      // const cursorReq = this.target.openCursor(key);
      // cursorReq.onsuccess
      throw Error('Calling delete() with a key range is currently unsupported.');
    } else {
      const objectKeys: Record<string, unknown> = {};
      if (this.target.keyPath) {
        if (Array.isArray(this.target.keyPath)) {
          // If the object store's `keyPath` is an array (i.e., of property names), then the `key` param should be also
          // be an array (of values).
          if (!Array.isArray(key)) {
            throw new TypeError(`"key" param must be an array since object store's "keyPath" is an array.`);
          }

          // Build up an object that will have all the required key props and values.
          this.target.keyPath.forEach((keyName, i) => {
            objectKeys[keyName] = key[i];
          });
        } else {
          objectKeys[this.target.keyPath] = key;
        }
      }

      // TODO: Proxy the request returned by put() so that attempts to access the .result property, or attempts to
      // assign an 'onsuccess' handler function which accesses the `event.result` property, properly ensure that
      // `result` is always `undefined` (per the official `delete()` API). For now, `result` will have the result of
      // the `put()` operation--a minor deviation from the proxied API that is unlikely to cause problems.
      return this.proxiedPut({ ...objectKeys, [SOFT_DELETED_PROP]: true }, key);
    }
  };

  proxiedGet = (...args: Parameters<IDBObjectStore['get']>): ReturnType<IDBObjectStore['get']> => {
    const realGetRequest = this.target.get.apply(this.target, args);

    return new Proxy(realGetRequest, {
      get(target, prop, receiver) {
        if (prop === 'result') {
          // Intercept calls to access `request.result` and returned a version of the result in which soft deleted
          // objects are removed.
          return filterSoftDeleted(target.result);
        }

        return Reflect.get(target, prop, receiver);
      },

      set(target, prop, value, receiver) {
        if (prop === 'onsuccess' && typeof value === 'function') {
          // Intercept calls for assigning a function to the 'onsuccess' property, and assign our own function
          // instead. This, in turn, will handle the successful request by calling the upstream developer's onsuccess
          // handler, but pass it a "rebuilt" version of the event that has the _filtered_ results instead.
          target.onsuccess = function(this, event) {
            value({
              ...event,
              target: {
                ...event.target,
                result: filterSoftDeleted(this.result),
              },
            });
          };
          // Proxies return true to indicate that an assignment succeeded (https://preview.tinyurl.com/y7n5qhly).
          return true;
        }

        return Reflect.set(target, prop, value, receiver);
      },
    });
  };

  /**
   * This method is used to intercept a call to the object store's getAll() method so we have a chance to remove soft
   * deleted objects from the results. We're declaring it as a class property initialized to an arrow function to ensure
   * that `this` will resolve correctly (an alternative to re-binding a class method to `this` in the constructor).
   */
  proxiedGetAll = (...args: Parameters<IDBObjectStore['getAll']>): ReturnType<IDBObjectStore['getAll']> => {
    const realGetAllRequest = this.target.getAll.apply(this.target, args);

    return new Proxy(realGetAllRequest, {
      get(target, prop, receiver) {
        if (prop === 'result') {
          // Intercept calls to access `request.result` and returned a version of the result in which soft deleted
          // objects are removed.
          return filterSoftDeleted(target.result);
        }

        return Reflect.get(target, prop, receiver);
      },

      set(target, prop, value, receiver) {
        if (prop === 'onsuccess' && typeof value === 'function') {
          // Intercept calls for assigning a function to the 'onsuccess' property, and assign our own function
          // instead. This, in turn, will handle the successful request by calling the upstream developer's onsuccess
          // handler, but pass it a "rebuilt" version of the event that has the _filtered_ results instead.
          target.onsuccess = function(this, event) {
            value({
              ...event,
              target: {
                ...event.target,
                result: filterSoftDeleted(this.result),
              },
            });
          };
          // Proxies return true to indicate that an assignment succeeded (https://preview.tinyurl.com/y7n5qhly).
          return true;
        }

        return Reflect.set(target, prop, value, receiver);
      },
    });
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

    if (key) {
      objectKey = key;
    } else {
      // If key wasn't specified, use `this.target.keyPath` to access a value on the object and use that as the ID
      if (Array.isArray(this.target.keyPath)) {
        objectKey = this.target.keyPath.map((prop) => newValue[prop]);
      } else {
        objectKey = newValue[this.target.keyPath];
      }
    }

    objectKey = JSON.stringify(objectKey);
    let entries: OpLogEntry[] = [];

    if (typeof newValue === 'object') {
      // Convert each property in the `value` to an OpLogEntry.
      for (const property in newValue) {
        entries.push({
          hlcTime: HLClock.tick().toString(),
          store: this.target.name,
          objectKey,
          prop: property,
          value: newValue[property],
        });
      }
    } else {
      // It's possible to store non-object primitives in an object store, too (e.g., `store.put(true, "someKey")`).
      entries.push({
        hlcTime: HLClock.tick().toString(),
        store: this.target.name,
        objectKey,
        prop: null,
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
        `Error ocurred when attempting to get reference to the "${STORE_NAME.OPLOG}" store (this may have happened ` +
        `because "${STORE_NAME.OPLOG}" wasn't included when the transaction was created): ${error.toString()}`;
      throw new Error(errorMsg);
    }

    // For each OpLogEntry object:
    // 1. Attempt to find an existing OpLogEntry for the same store/object/field.
    // 2. If existing entry is older than the one we just created, or none exists, then it's ok that the original
    //    `put()` mutation happened. If, however, a more recent pre-existing operation was found, we need to re-apply
    //    THAT mutation (i.e., roll back / undo the mutation that just took place).
    // 3. If existing entry has a different timestamp than the one we just created, or none exists, add the OpLogEntry
    //    we just created to the entries store.
    for (const entry of entries) {
      //TODO: get the most recent local entry
      oplogStore.add(entry);
    }
  };

  // applyOpLogEntries(entries: OpLogEntry[]) {
  //   // TODO:
  //   // 1. Get reference to internal OplogEntries collection.
  //   // 2. Search for most recent existing entry for given store/idPath/idValue
  //   // 3. If `entry` is newer, proceed with mutation
  //   // 4. Get reference target object store
  //   // 5. Get existing object from store
  //   // 6. Apply entry operation

  //   const db = await getOpLoggyDb();
  //   const entryStore = await getStore(db, oplogStoreName, 'readonly');
  //   entryStore.db.transaction(oplogStoreName, 'readonly').objectStore(oplogStoreName);
  // }
}

/**
 * A Typescript "type guard" for safely casting something to a type.
 */
export function isThingWithDeletedProp(thing: unknown): thing is ThingWithDeletedProp {
  const result = thing !== null && typeof thing === 'object' && SOFT_DELETED_PROP in (thing as object);
  return result;
}

/**
 * A utility function for returning things only if they haven't been "soft deleted".
 */
function filterSoftDeleted(thing: unknown): unknown {
  let filtered = thing;
  if (Array.isArray(thing)) {
    filtered = thing.filter((item) => (isThingWithDeletedProp(item) && item[SOFT_DELETED_PROP] ? false : true));
  } else {
    filtered = isThingWithDeletedProp(thing) && thing[SOFT_DELETED_PROP] ? null : thing;
  }
  return filtered;
}

/**
 * A utility function for deriving a key value that can be used to retrieve an object from an IDBObjectStore.
 */
function resolveKey(store: IDBObjectStore, value: any, key?: IDBValidKey) {
  const resolvedKey = Array.isArray(store.keyPath)
    ? store.keyPath.map((keyProp) => value[keyProp])
    : store.keyPath
    ? value[store.keyPath]
    : key;

  if (!resolvedKey || (Array.isArray(resolvedKey) && resolvedKey.length === 0)) {
    throw new Error('IDBSideSync: failed to establish a key for retrieving object before updating it.');
  }
  return resolvedKey;
}
