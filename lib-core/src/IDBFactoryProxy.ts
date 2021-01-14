/**
 * Instances of this class can intercept and modify calls to the IndexedDB API if used as a Proxy handler, wrapping
 * window.indexedDB.
 */
export class IDBFactoryProxy {
  get(target: IDBFactory, prop: keyof IDBFactory, receiver: unknown) {
    if (prop === 'open') {
      // Intercept attempts to access to the `open` function and return our own function instead. This allows us to
      // ensure that when `open` is invoked, we can wrap the resulting "request" object in another Proxy.
      return this.open;
    }

    return Reflect.get(target, prop, receiver);
  }

  open(name: string, version?: number): IDBOpenDBRequest {
    console.log('🥸 IDBFactoryProxy.open()');
    const request = indexedDB.open(name, version);

    // The code calling our proxy will likely attempt to assign a function to `request.onupgradeneeded`. For example:
    //
    //   req.onupgradeneeded = (event) => {
    //      event.currentTarget.result.createObjectStore(...);
    //   }
    //
    // We need to ensure that both the user's and our 'onupgradeneeded' handlers run (i.e., so that everybody gets a
    // chance to do create their object stores, indices, etc.). Because users will do this by _assigning_ their own
    // function to `request.onupgradeneeded`, we'll need to wrap the `request` in another Proxy so that we can
    // intercept the assigment operation.
    return new Proxy(request, new IDBOpenDBRequestProxy());
  }
}

class IDBOpenDBRequestProxy {
  target?: IDBOpenDBRequest;
  theirOnupgradeneeded?: IDBOpenDBRequest['onupgradeneeded'];

  // get(target: IDBOpenDBRequest, prop: keyof IDBOpenDBRequest, receiver: unknown) {
  //   return Reflect.get(target, prop, receiver);
  // }

  set(target: IDBOpenDBRequest, prop: keyof IDBOpenDBRequest, value: unknown, receiver: unknown) {
    this.target = target;

    if (prop === 'onupgradeneeded') {
      // Instead of allowing the user to assign _their_ function to 'onupgradeneeded', assign _our_ function.
      target.onupgradeneeded = (event) => {
        this.upgradeOpLoggyDb(event, value);
      };

      // Proxies return true to indicate that an assignment succeeded (https://preview.tinyurl.com/y7n5qhly).
      return true;
    }

    return Reflect.set(target, prop, value, receiver);
  }

  upgradeOpLoggyDb(event: IDBVersionChangeEvent, theirOnUpgradeHandler: unknown) {
    console.log('🥸 🎉  IDBOpenDBRequestProxy.oploggyOnUpgradeNeeded()');

    // @ts-ignore
    const db: IDBDatabase = event.target.result;

    const oplogStore = db.createObjectStore('oplog', { keyPath: 'hlcTime' });

    // We will frequently need to answer the question "what is the most recent oplog entry for the 'customers' object
    // store where customerId = 123?". This means we'll need to quickly query where `store = 'customers' AND idPath =
    // 'customerId' AND idValue = 123`.
    oplogStore.createIndex('store', 'store', { unique: false });
    oplogStore.createIndex('idPath', 'idPath', { unique: false });
    oplogStore.createIndex('idValue', 'idValue', { unique: false });

    // We can't assign our own handlers to oplogStore.transaction.oncomplete/onerror/etc without triggering an
    // InvalidStateError "downstream" when the user tries to create their own object stores.

    if (typeof theirOnUpgradeHandler === 'function') {
      (theirOnUpgradeHandler as Function)?.call(this.target, event);
    }

    // // Don't allow the user's `onupgradeneeded` handler to run until ours has successfully finished setting up the
    // // stores/indices that OpLoggy needs. This helps ensure that the user can't start doing CRUD operations with their
    // // own stores until OpLoggy is ready to record entries for those operations.
    // oplogStore.transaction.oncomplete = () => {
    //   if (typeof theirOnUpgradeHandler === 'function') {
    //     (theirOnUpgradeHandler as Function)?.call(this.target, event);
    //   }
    // };

    oplogStore.transaction.onerror = () => {
      throw new OpLoggyProxyError(`Failed to create OpLoggy's oplog object store in IndexedDB.`);
    };

    oplogStore.transaction.onabort = () => {
      //TODO
    };
  }
}

class OpLoggyProxyError extends Error {
  public type: string;

  constructor(message: string) {
    super();
    this.type = 'OpLoggyProxyError';
    this.message = message;
    // TypeScript team recommends also calling Object.setPrototypeOf() when extending built-in classes such as Error
    // (but notes it might not work in IE <= 10): https://preview.tinyurl.com/y4jhzjgs
    Object.setPrototypeOf(this, Error);
  }
}

// /**
//  * This class maintains the log of all data change operations.
//  */
// export class OpLoggy {
//   // static IDBOpenDBRequestProxy =

//   // private static singleton: OpLog;

//   // /**
//   //  * Note that even though a constructor function must be invoked to use this class, we're using the singleton pattern
//   //  * to ensure that only a single instance exists. The thinking here is that this class models _shared_ state--there's
//   //  * no need for separate instances of it to exist, each with their own state. Also, a constructor function is a nice
//   //  * "gateway to the class" for ensuring that any setup/initializtion work always happens, and makes it possible to put
//   //  * dependency checks in a single place (e.g., if a database object wasn't passed in, throw an error).
//   //  */
//   // constructor() {
//   //   if (OpLog.singleton) {
//   //     return OpLog.singleton;
//   //   }

//   //   OpLog.singleton = this;
//   // }

//   //TODO: consider having the actual storage mechanism (e.g., indexeddb object vs. in-memory) be passed-in
//   constructor() {}

//   addEntry(entry: unknown) {
//     if (!isValidOplogEntry(entry)) {
//       throw new OpLoggy.InvalidEntryError(entry);
//     }

//     const foo: IDBFactory = window.indexedDB;

//     // const db = await openDB('mydb', version, {
//     //   upgrade(db, oldVersion, newVersion, transaction) {
//     //     // …
//     //   },
//     //   blocked() {
//     //     // …
//     //   ,}
//     //   blocking() {
//     //     // …
//     //   },
//     //   terminated() {
//     //     // …
//     //   },
//     // });
//   }

//   findMostRecentEntryFor({ store, id, prop }: Omit<OpLogEntry, 'value' | 'timestamp'>): OpLogEntry | null {
//     return null;
//   }

// static InvalidEntryError = class extends Error {
//   public type: string;

//   constructor(entry: unknown) {
//     super();
//     this.type = 'InvalidEntryError';
//     this.message = 'Not a valid oplog entry object: ' + JSON.stringify(entry);
//     // TypeScript team recommends also calling Object.setPrototypeOf() when extending built-in classes such as Error
//     // (but notes it might not work in IE <= 10): https://preview.tinyurl.com/y4jhzjgs
//     Object.setPrototypeOf(this, Error);
//   }
// };
// }
