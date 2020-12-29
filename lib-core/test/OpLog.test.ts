// Importing `fake-indexeddb/auto` causes several global variables that are part of the IndexedDB API to be replaced
// with versions from fake-indexeddb that work in memory, allowing us to have in-memory IndexedDB in Node.
import 'fake-indexeddb/auto';
// @ts-ignore (since Typescript types don't currently exist for faked-indexedDB)
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import { IDBPDatabase, openDB, deleteDB, wrap, unwrap } from 'idb';

import { HLTime } from '../HLTime';
import { proxyStore } from '../IDBObjectStoreProxy';

jest.setTimeout(10000);

describe('OpLog', () => {
  beforeEach(() => {
    // @ts-ignore (since window.indexedDB is readonly and a different type)
    window.indexedDB = new FDBFactory(); // Reset the state of the fake IndexedDB API
  });

  describe('Proxy', () => {
    it('intercepts calls to store.add()', (onTestDone) => {
      const spongebObj = { id: 1, name: 'spongebob', species: 'sponge' };
      const patrickObj = { id: 2, name: 'patrick', species: 'starfish' };
      const onSpongebobAddSuccessFcn = jest.fn();
      const onPatrickAddSuccessFcn = jest.fn();

      const handleUpgradeNeeded: IDBOpenDBRequest['onupgradeneeded'] = jest.fn(function (
        // The 'this' parameter is "fake" and only here for the benefit of the TypeScript compiler. We are using it to
        // tell tsc what type 'this' is inside our function. We only need to do this because we are wrapping the
        // function with `jest.fn(...)`. See https://www.typescriptlang.org/docs/handbook/functions.html#this-parameters
        this: IDBOpenDBRequest,
        event: IDBVersionChangeEvent
      ) {
        const db = this.result;
        const objectStore = db.createObjectStore('customers', { keyPath: 'id' });
        // const objectStore = new IDBObjectStoreProxy(db.createObjectStore('customers', { keyPath: 'id' }));

        objectStore.createIndex('name', 'name', { unique: false });

        // Use transaction oncomplete to make sure the objectStore creation is finished before adding data into it.
        objectStore.transaction.oncomplete = function (event) {
          const customersTransaction = db.transaction('customers', 'readwrite');
          const customerObjectStore = proxyStore(customersTransaction.objectStore('customers'));

          // Add a new object via add()
          customerObjectStore.add(spongebObj).onsuccess = onSpongebobAddSuccessFcn;

          // Now update only _one_ field in that existing object (i.e., partial update).
          const updateSBobReq = customerObjectStore.put({ id: 1, name: 'Robert Squarepants' });
          updateSBobReq.onsuccess = () => {
            // Verify that `updateSBobReq.result` has the correct key.
            console.log(updateSBobReq.result);
            console.log(updateSBobReq.error);
          };

          // Use put() to add another new object
          const updatePatrickReq = customerObjectStore.put(patrickObj);
          updatePatrickReq.onsuccess = () => {
            // Verify that `updatePatrickReq.result` has the correct key.
            console.log(updatePatrickReq.result);
            console.log(updatePatrickReq.error);

          };

          // Now test that oplog entries exist for everything that happened and that the main store looks like this:
          // 1. { id: 1, name: 'S. Bob Squarepants', species: 'sponge' }
          // 2. { id: 2, name: 'patrick', species: 'starfish' }
          customerObjectStore.transaction.oncomplete = finishTest;
        };
      });

      const openDbRequest = window.indexedDB.open('mydatabase', 1);

      openDbRequest.onupgradeneeded = handleUpgradeNeeded;

      function finishTest() {
        // @ts-ignore
        const stores: Map = window.indexedDB._databases.get('mydatabase').rawObjectStores;
        expect(stores.has('customers')).toBeTruthy();

        // @ts-ignore
        const records = stores.get('customers').records.records;

        // @ts-ignore
        const patrickRecord = records.find((record) => record.key === patrickObj.id);
        expect(patrickRecord).toEqual({ key: patrickObj.id, value: patrickObj });

        // @ts-ignore
        const spongebobRecord = records.find((record) => record.key === spongebObj.id);
        expect(spongebobRecord).toEqual({ key: spongebObj.id, value: spongebObj });

        expect(onSpongebobAddSuccessFcn).toHaveBeenCalledTimes(1);
        expect(onPatrickAddSuccessFcn).toHaveBeenCalledTimes(1);
        onTestDone();
      }
    });
  });

  // describe('IDB tests', () => {
  //   const name = { db: 'testDb', table1: 'table1' };

  //   it('test 1', async () => {
  //     const upgradeFcn = jest.fn((db: IDBPDatabase) => {
  //       expect(db.objectStoreNames.contains(name.table1)).toBeFalsy();
  //       db.createObjectStore(name.table1, { autoIncrement: true });
  //     });

  //     const db = await openDB(name.db, 1, {
  //       upgrade: upgradeFcn,
  //     });

  //     // TODO: Create a separate Proxy for the idb library? Or maybe figure out how to use idb's wrap() function to
  //     // wrap some "real" IndexedDB objec that has an OpLoggy proxy around it. Will need to look at idb's code to see
  //     // how to access the actual, underlying IDBObjectStore instance.
  //     const tx = db.transaction(name.table1, 'readwrite');
  //     const store = tx.objectStore(name.table1);
  //     await store.put({ name: 'patrick' });
  //     await store.put({ name: 'spongebob' });
  //     await store.put({ name: 'squidward' });

  //     const result = await store.getAll();
  //     console.log(result);

  //     expect(upgradeFcn).toBeCalled();
  //   });

  //   it('test 2', async () => {
  //     const upgradeFcn = jest.fn((db: IDBPDatabase) => {
  //       expect(db.objectStoreNames.contains(name.table1)).toBeFalsy();
  //       db.createObjectStore(name.table1, { autoIncrement: true });
  //     });

  //     // const fakeIdb = wrap(window.indexedDB)
  //     const db = await openDB(name.db, 1, {
  //       upgrade: upgradeFcn,
  //     });

  //     expect(upgradeFcn).toBeCalled();
  //   });
  // });

  // const sampleTimestamps = [
  //   new HLTime(1604855747036, Number(123), 'spongebob'),
  //   new HLTime(539802947036, Number(456), 'patrick'),
  //   new HLTime(2120087747036, Number(789), 'squidward'),
  // ];

  // describe('addEntry()', () => {
  //   // it(`throws if entry param is missing`, () => {
  //   //   const opLog = new OpLog();
  //   //   expect(() => {
  //   //     // @ts-ignore since we are deliberately violating parameter type
  //   //     opLog.addEntry();
  //   //   }).toThrow(OpLog.InvalidEntryError);
  //   // });

  //   // it(`throws if entry timestamp is invalid`, () => {
  //   //   const opLog = new OpLog();
  //   //   expect(() => {
  //   //     // @ts-ignore line since we are deliberately violating parameter type
  //   //     opLog.addEntry({
  //   //       collection: 'collection1',
  //   //       documentId: 'document1',
  //   //       property: 'property1',
  //   //       value: 'value1',
  //   //       timestamp: '',
  //   //     });
  //   //   }).toThrow(OpLog.InvalidEntryError);
  //   // });

  //   // it(`works if a valid param is passed in`, () => {
  //   //   const opLog = new OpLog();
  //   //   const expectedEntry: OplogEntry = {
  //   //     docCollection: 'collection1',
  //   //     docId: 'document1',
  //   //     docProp: 'property1',
  //   //     value: 'value1',
  //   //     timestamp: sampleTimestamps[0].toString(),
  //   //   };
  //   //   opLog.addEntry(expectedEntry);
  //   // });
  // });
});
