import { STORE_NAMES } from './db';

export function proxyStore(target: IDBObjectStore): IDBObjectStore {
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
      throw new Error(`OpLoggy can't work with object stores whose .autoIncrement property is set to true.`);
    }

    this.target = target;
  }

  get(target: IDBObjectStore, prop: keyof IDBObjectStore, receiver: unknown) {
    this.target = target;

    // Pull the 'ol switcheroo when the add/put methods are accessed, but use `bind()` to ensure that, when our
    // implementation is called instead, `this` will actually refer to this `IDBObjectStoreProxy` instance and NOT the
    // real object store.
    if (prop === 'add') {
      return this.add.bind(this);
    } else if (prop === 'put') {
      return this.put.bind(this);
    }

    return Reflect.get(target, prop, receiver);
  }

  /**
   * This method is used to intercept a call to the object store's add() method so we have a chance to record the the
   * mutations as oplog entries.
   */
  add(value: any, key?: IDBValidKey): IDBRequest<IDBValidKey> {
    this.recordOperation(value, key);
    return this.target.add(value, key);
  }

  /**
   * This method is used to intercept a call to the object store's put() method so we have a chance to record the
   * mutations as oplog entries.
   */
  put(value: any, key?: IDBValidKey): IDBRequest<IDBValidKey> {
    this.recordOperation(value, key);
    return this.target.put(value, key);
  }

  /**
   * This method is used to convert an object that was just "put" into an object store into 1+ oplog entries that can be
   * recorded and shared so the operation can be re-created as part of a CRDT. It should only be called as part of the
   * same transaction used to perform the actual add()/put() so that if operation fails--or if the attempt to add an
   * object to the oplog store fails--all of the operations are rolled back.
   *
   * The optional `key` arg should only exist if the proxied object store was created without a `keyPath`. For a nice
   * summary of possible `keyPath` and `autoIncrement` permutations, and what that means for the object store, see
   * https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB#Structuring_the_database.
   */
  recordOperation(newValue: any, key?: IDBValidKey) {
    if (key instanceof ArrayBuffer || key instanceof DataView) {
      throw new TypeError(`Keys of type ArrayBuffer or DataView aren't currently supported.`);
    } else if (Array.isArray(key)) {
      const foundArrBuffItem = key.find(() => key instanceof ArrayBuffer || key instanceof DataView);
      if (foundArrBuffItem) {
        throw new TypeError(`Keys of type ArrayBuffer or DataView aren't currently supported.`);
      }
    }

    //TODO: For each OpLogEntry object:
    // 1. Attempt to find an existing OpLogEntry for the same store/object/field.
    // 2. If existing entry is older than the one we just created, or none exists, then it's ok that the original
    //    `put()` mutation happened. If, however, a more recent pre-existing operation was found, we need to re-apply
    //    THAT mutation (i.e., roll back / undo the mutation that just took place).
    // 3. If existing entry has a different timestamp than the one we just created, or none exists, add the OpLogEntry
    //    we just created to the entries store.

    /* eslint-disable @typescript-eslint/no-unused-vars */
    let objectIdentifier;

    if (key) {
      objectIdentifier = key;
    } else {
      // If key wasn't specified, use `this.target.keyPath` to access a value on the object and use that as the ID
      if (Array.isArray(this.target.keyPath)) {
        objectIdentifier = this.target.keyPath.map((prop) => newValue[prop]);
      } else {
        objectIdentifier = newValue[this.target.keyPath];
      }
    }

    objectIdentifier = JSON.stringify(objectIdentifier);
    let entries: OpLogEntry[] = [];

    // if (typeof newValue === 'object') {
    //   // Convert the `value` to 1+ OpLogEntry objects
    //   for (const property in newValue) {
    //     entries.push({
    //       hlcTime: HLClock.tick().toString(),
    //       store: this.target.name,
    //       objectId: objectIdentifier,
    //       field: property,
    //       value: newValue[property],
    //     });
    //   }
    // } else {
    //   entries.push({
    //     hlcTime: HLClock.tick().toString(),
    //     store: this.target.name,
    //     objectId: objectIdentifier,
    //     field: null,
    //     value: newValue,
    //   });
    // }

    let oplogStore;
    try {
      // When getting a reference to our own object store where the operation will be recorded, it's important that we
      // reuse the existing transaction. By doing so, both recording the operation and performing the operation are part
      // of the same transaction; we can ensure that if anything fails for some reason, nothing will be persisted.
      oplogStore = this.target.transaction.objectStore(STORE_NAMES.OPLOG);
    } catch (error) {
      const errorMsg =
        `Error ocurred when attepmting to get reference to the "${STORE_NAMES.OPLOG}" store (this may have happened ` +
        `because "${STORE_NAMES.OPLOG}" wasn't included when the transaction was created): ${error.toString()}`;
      throw new Error(errorMsg);
    }

    for (const entry of entries) {
      //TODO: get the most recent local entry
      oplogStore.add(entry);
    }
  }

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
