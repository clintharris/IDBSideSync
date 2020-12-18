import { proxyPutRequest } from './IDBUpsertRequestProxy';

export function proxyStore(target: IDBObjectStore): IDBObjectStore {
  const proxy = new IDBObjectStoreProxy(target);
  return new Proxy(target, proxy);
}

export class IDBObjectStoreProxy {
  target: IDBObjectStore;

  constructor(target: IDBObjectStore) {
    if (target.autoIncrement) {
      // This won't work... If IndexedDB is auto-assigning the object IDs, then it's possible for two separate clients
      // to create an object with the same key/ID. In that scenario, there's no safe way to share and apply oplog
      // entries (i.e., CRDT messages) since they might describe mutations that _appear_ to be relevant to the same
      // object but actually could refer to different objects that have the same key/ID.
      throw new Error(`OpLoggy can't work with object stores whose .autoIncrement property is set to true.`);
    }

    // Note that it's ok if `target.keyPath` is null; however, all calls to `add()` and `put()` will need to include the
    // "keyPath" parameter so that IndexedDB knows which property on the object should be used as the key for the
    // object.
    this.target = target;
  }

  get(target: IDBObjectStore, prop: keyof IDBObjectStore, receiver: unknown) {
    this.target = target;

    if (prop === 'add' || prop === 'put') {
      // Pull the 'ol switcheroo, but use `bind()` to ensure that, when our `put()` method is called, `this` will
      // actually refer to this `IDBObjectStoreProxy` instance and NOT the real object store.
      return this.put.bind(this);
    }

    return Reflect.get(target, prop, receiver);
  }

  /**
   * This method is used to intercept a call to the object store's put() method so we have a chance to record the record
   * the mutations as oplog entries.
   */
  put(value: any, key?: IDBValidKey): IDBRequest<IDBValidKey> {
    return proxyPutRequest(this.target.put(value, key), {
      onSuccess: () => {
        // The call to target.put() succeeded; we now know it's worthwhile to record the operation.
        this.recordPut(value, key);
      },
    });
  }

  /**
   * This method is used to convert an object (that was just "put" into an object store) into 1+ oplog entries that
   * can be recorded and used to re-create the operation.
   *
   * This method should only be called after the original put() operation has successfully completed for the object
   * object store that is being proxied.
   *
   * Note that the optional `key` arg should only exist if the proxied object store was created without a `keyPath`.
   * In that scenario, IndexedDB doesn't know which property of the objects to use as primary identifiers--the property
   * has to be specified each time an object is added/updated. Conversely, specifying `key` if the object store was
   * created with a `keyPath` is not allowed and would cause an error.
   */
  async recordPut(value: any, key?: IDBValidKey) {
    // const db = await getDb();
    console.log('TODO: create oplog entry for put():', value);

    // If `key` was specified, use that for the `idPath` and use the value it references as `idValue`. This handles
    // scenarios such as the following:
    //   db.createObjectStore("StoreWithoutAKeyPath"); // NO 'keyStore' arg specified
    //   storeWithoutKeyPath.add({ foo: "Thing 1" }, "foo"); // idPath = 'foo', idValue = 'Thing 1'
    //   storeWithoutKeyPath.add({ bar: "Thing 2" }, "bar"); // idPath = 'bar', idValue = 'Thing 2'
    //   storeWithoutKeyPath.add({ baz: "Thing 3" }, "baz"); // idPath = 'baz', idValue = 'Thing 3'

    //TODO: break down the 'value' object into a bunch of oplog entries. Something like this:
    // let fields = Object.keys(params).filter((k) => k !== 'id');
    // const entries = fields.map((k) => {
    //   return {
    //     dataset: table,
    //     row: params.id,
    //     column: k,
    //     value: params[k],
    //     timestamp: Timestamp.send(getClock()).toString(),
    //   };
    // });
  }

  // async applyOpLogEntries(entries: OpLogEntry[]) {
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
