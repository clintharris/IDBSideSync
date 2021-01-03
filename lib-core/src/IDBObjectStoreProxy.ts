import { STORE_NAME } from './db';
import { HLClock } from './HLClock';

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
      throw new Error(`IDBSideSync: You must specify the "key" param when calling add() on a store without a keyPath.`);
    }
    this.recordOperation(value, key);
    return this.target.add(value, key);
  };

  proxiedPut = (value: any, key?: IDBValidKey): ReturnType<IDBObjectStore['put']> => {
    if (!this.target.keyPath && !key) {
      throw new Error(`IDBSideSync: You must specify the "key" param when calling add() on a store without a keyPath.`);
    }
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

    const objectKey = resolveKey(this.target, newValue, key);

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

// function buildKeyObj(store: IDBObjectStore, value: any, key?: IDBValidKey) {
//   if (Array.isArray(store.keyPath)) {
//     let keyObj: Record<string, any> = {};
//     for (const keyName of store.keyPath) {
//       keyObj[keyName] = value[keyName];
//     }
//     return keyObj;
//   } else if (store.keyPath) {
//     return { [store.keyPath]: value[store.keyPath] };
//   } else if (!key) {
//     throw new Error(`IDBSideSync: Unable to build a key object.`);
//   } else {
//     return key;
//   }
// }
