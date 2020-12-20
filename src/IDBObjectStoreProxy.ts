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
    //TODO: support ArrayBuffer/DataView keys, or keys that are arrays of those types.
    // Until support for deterministically converting ArrayBuffer/DataView instances to strings (so that they can be
    // used as JSON-friendly OpLogEntry key values) is implemented, make it clear that keys of this type aren't
    // supported. It should  possible to do this by iterating over the bytes in the buffer and either generating a big,
    // hashable, string--or maybe just creating simple bitwise hash. Maybe something like this:
    // `const buffHash = bytes.reduce((acc, currByte) => acc ^ currByte).` Use a for-loop with arrayBuffer.byteLength.
    if (key instanceof ArrayBuffer || key instanceof DataView) {
      throw new TypeError(`OpLoggy currently doesn't support add()/put() when key is of type ArrayBuffer or DataView`);
    } else if (Array.isArray(key)) {
      const foundArrBuffItem = key.find((item) => key instanceof ArrayBuffer || key instanceof DataView);
      if (foundArrBuffItem) {
        throw new TypeError(
          `OpLoggy currently doesn't support add()/put() when key is of type ArrayBuffer or DataView`
        );
      }
    }

    return proxyPutRequest(this.target.put(value, key), {
      onSuccess: () => {
        // The call to target.put() succeeded; we now know it's worthwhile to record the operation. This also means that
        // if the `keyPath` arg was specified we can assume it really is of type IDBValidKey (since IndexedDB allowed it
        // to be used).
        this.recordPut(value, key);
      },
    });
  }

  /**
   * This method is used to convert an object that was just "put" into an object store into 1+ oplog entries that can be
   * recorded and shared so the operation can be re-created as part of a CRDT. It should only be called after the
   * original put() operation has successfully completed for the object object store that is being proxied.
   *
   * The optional `key` arg should only exist if the proxied object store was created without a `keyPath`.
   */
  async recordPut(value: any, key?: IDBValidKey) {
    //TODO: Convert the `value` to 1+ OpLogEntry objects.

    //TODO: For each OpLogEntry object:
    // 1. Attempt to find an existing OpLogEntry for the same store/object/field.
    // 2. If existing entry is older than the one we just created, or none exists, then it's ok that the original
    //    `put()` mutation happened. If, however, a more recent pre-existing operation was found, we need to re-apply
    //    THAT mutation (i.e., roll back / undo the mutation that just took place).
    // 3. If existing entry has a different timestamp than the one we just created, or none exists, add the OpLogEntry
    //    we just created to the entries store.

    // 🚨 This means that each time an object is `put()` into a store, we are creating oplog entries that set values for
    // ALL properties of the object--NOT just the properties that were actually mutated (e.g., maybe an object was
    // retrieved, only a single property was changed, and then it was `put()` back into the store). The net effect of
    // this is that the last person to modify any part of an object ends up setting ALL properties for the object (based
    // on what that person knew of the object at that time). If User A mutates `obj1.foo` and User B mutates `obj1.bar`,
    // whomever's `put()` happened last will determine the value for BOTH `foo` and `bar` properties.
    //
    // The only way to prevent this problem is to somehow isolate the specific fields that were mutated. Some options:
    //
    // 1. Proxy/intercept calls to `get()/getAll()` so that they are wrapped in some other object that can detect
    //    mutations as they are made. This seems like a poor solution since there's no guarantee the user would use this
    //    same "tracked" object when calling `put()` later.
    // 2. Try to discern which fields were mutated by doing some sort of diff calculation on the existing object. This
    //    seems complicated and possibly error prone.
    // 3. Stop supporting the direct use of put()`; only support mutations that happen through a custom function where
    //    the caller only specifies a sub-set of affected fields (i.e., the caller tells us which fields are being
    //    modified vs. passing in the entire object each time). This is how Long's demo CRDT app works.
    // 4. Stop proxying IndexedDB stores entirely.
    //
    // It's worth considering that it's common for app developers to NOT keep track of individual field mutations. It's
    // more common, for example, to get an object, render it as a form, and persist that entire object when the form is
    // submitted. With that in mind, _someone_ will need to calculate which object fields are modified--either the
    // majority of developers using the library with this typical workflow, or the library itself. The latter would be
    // preferable if it can be implemented reliably.
    //
    // 💡 The goal is really to avoid recording entries for fields that weren't modified. You can either rely on the
    // user to tell you which fields they want modified (similar to what J. Long did in his CRDT demo app), or the
    // library can infer this itself. Figuring out what changed could happen by finding the most recent oplog entry for
    // EACH field and comparing the 'set' value; if it differs, record the mutation, otherwise don't bother persisting
    // the OpLogEntry. One benefit to doing the "diff" by using oplog entries for each field in the object vs. comparing
    // two full objects (i.e., before and after snapshots), is that the diffing can be done entirely using OpLoggy's own
    // database and store--there's no need to query the target database/store for the full object to capture it _before_
    // the put() happens, for example.
    //
    // For example, say the following object exists in a 'pets' store: { id: 123, animal: "cat", color: "yellow", name:
    // "Gary" }
    //
    // This means the following oplog entries should exist:
    //  1. { time: ..., store: 'pets', key: 123, field: 'animal', value:='cat' }
    //  2. { time: ..., store: 'pets', key: 123, field: 'color', value:='yellow' }
    //  3. { time: ..., store: 'pets', key: 123, field: 'name', value:='Gary' }
    //
    // Then say the following happens: put({ id: 123, animal: "snail", color: "yellow", name: "Gary", age: 3 })
    //
    // 1. Convert the `put()` arg to oplog entries:
    //  - { time: ..., store: 'pets', key: 123, field: 'animal', value: 'snail' }
    //  - { time: ..., store: 'pets', key: 123, field: 'color', value: 'yellow' }
    //  - { time: ..., store: 'pets', key: 123, field: 'name', value: 'Gary' }
    //  - { time: ..., store: 'pets', key: 123, field: 'age', value: '3' }
    //
    // 2. For each new oplog entry, try to find the MOST RECENT EXISTING entry for that field.
    //
    // 3. Only keep the new entries that don't have a pre-existing entry, or whose value differs:
    //  - { time: ..., store: 'pets', key: 123, field: 'animal', value: 'snail' }
    //  - { time: ..., store: 'pets', key: 123, field: 'age', value: '3' }
    //
    // 🚨 Problem: what if a new "color=red" message was received in the background after object was loaded and rendered
    // as a form (with color=yellow), but before our call to put()? In this case, it would incorrectly appear that we
    // are mutating the "color" field since our value is "yellow" and the most recent oplog entry for that field has
    // value=red. But of course we didn't actually mutate the "color" field, we're just trying to persist out-of-date
    // data.
    //
    // This problem still exists if you try to do a clever "compare before & after snapshots to figure out what the user
    // modified" approach. For example, say you tried to calculate the diff by intercepting and blocking the target
    // put(), and first doing a "readonly" get() for the object BEFORE executing the put()--this would make it possible
    // to capture a "before" snapshot that can be diffed against the put value to determine which fields are actually
    // being modified. However, if any of the object's properties were updated in the store in the background, then that
    // would cause those props to differ from the put() argument--so even non-modified properties were appear to have
    // been modified because they differ from the "before" snapshot.
    //
    // Conclusion: any time you try to infer which fields changed by comparing objects, you run the risk of doing the
    // comparison with an out-of-date objects, resulting in old data overwriting newer data.
    //
    // The problem with IndexedDB is that it works similarly to how an old-fashioned webapp works. You get the full
    // object from the server, render it an HTML form, the user changes some unknown set of fields, and then you POST
    // the thing back and overwrite whatever's in the database with the entire contents of the form.
    //
    // For a CRDT-based application to work properly you have to think differently about it and build it differently.
    // Each individual field is its own "form", and each change to that field is a POST.
    //
    // With a CRDT, your entire application is a spreadsheet. Creating a new object that represent a customer? No, you
    // are creating n new fields. You are adding a new row to the spredsheet, which really means adding some number of
    // new CELLS that are independently editable. Editing each cell is its own DB operation. This is why SQLite works
    // so well for J. Long--SQL's UPDATE syntax supports SETing individual columns in a table--individual cells in the
    // row. IndexedDB doesn't work that way--you only get to post the entire row.

    console.log('TODO: create oplog entry for put():', value);

    let objectIdentifier;

    if (key) {
      //TODO handle all the types that key could be...
    } else {
      // If key wasn't specified, use `this.target.keyPath` to access a value on the object and use that as the ID
      if (Array.isArray(this.target.keyPath)) {
        // TODO
      } else {
        objectIdentifier = value[this.target.keyPath];
      }
    }
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
