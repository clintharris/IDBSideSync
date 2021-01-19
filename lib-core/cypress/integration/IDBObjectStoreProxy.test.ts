import * as IDBSideSync from '../../src/index';
import {
  clearDb,
  getDb,
  onSuccess,
  TODO_ITEMS_STORE,
  ARR_KEYPATH_STORE,
  resolveOnTxComplete,
  throwOnReqError,
  NO_KEYPATH_STORE,
  assertEntries,
} from './utils';

context('IDBObjectStoreProxy', () => {
  beforeEach(async () => {
    await clearDb();
    const db = await getDb();
    await IDBSideSync.init(db);
  });

  describe('store.add() proxy', () => {
    it(`works with single-value keyPath`, async () => {
      const key = 1;
      const expectedTodo: TodoItem = { id: key, name: 'buy cookies', done: false };
      let foundTodo;
      let foundEntries;

      await txCompletion(TODO_ITEMS_STORE, (proxiedStore) => {
        proxiedStore.add(expectedTodo);
      });

      await txCompletion(TODO_ITEMS_STORE, async (proxiedStore, oplogStore) => {
        foundTodo = await onSuccess(proxiedStore.get(key));
        foundEntries = await onSuccess(oplogStore.getAll());
      });

      expect(foundTodo).to.deep.equal(expectedTodo);

      let previousHlcTime = '';
      foundEntries.forEach((entry: OpLogEntry) => {
        assert(entry.hlcTime > previousHlcTime, `each OpLogEntry's .hlcTime is greater than the previous time`);
        previousHlcTime = entry.hlcTime;
      });

      const sharedWhere = { store: TODO_ITEMS_STORE, objectKey: key };
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'id', value: expectedTodo.id } });
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'name', value: expectedTodo.name } });
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'done', value: expectedTodo.done } });
    });

    it(`works with array keyPath`, async () => {
      let foundSetting;
      let foundEntries;
      const key = ['foo', 'bar'];
      const expected: ScopedSetting = { scope: 'foo', name: 'bar', value: 'baz' };

      await txCompletion(ARR_KEYPATH_STORE, (proxiedStore) => {
        proxiedStore.add(expected);
      });

      await txCompletion(ARR_KEYPATH_STORE, async (store, oplogStore) => {
        foundSetting = await onSuccess(store.get(key));
        foundEntries = await onSuccess(oplogStore.getAll());
      });

      expect(foundSetting).to.deep.equal(expected);

      foundEntries.forEach((entry: OpLogEntry) => {
        expect(entry.objectKey).to.deep.equal([foundSetting.scope, foundSetting.name]);
      });

      const sharedWhere = { store: ARR_KEYPATH_STORE, objectKey: key };
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'scope', value: expected.scope } });
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'name', value: expected.name } });
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'value', value: expected.value } });
    });

    it(`works without a keyPath`, async () => {
      const key = 'foo';
      const initialValue = 'bar';
      let foundValue;
      let foundEntries;

      await txCompletion(NO_KEYPATH_STORE, (proxiedStore) => {
        proxiedStore.add(initialValue, key);
      });

      await txCompletion(NO_KEYPATH_STORE, async (store, oplogStore) => {
        foundValue = await onSuccess(store.get(key));
        foundEntries = await onSuccess(oplogStore.getAll());
      });

      // Verify that we found the initial value...
      expect(foundValue).to.deep.equal(initialValue);

      let previousHlcTime = '';
      foundEntries.forEach((entry: OpLogEntry) => {
        assert(entry.hlcTime > previousHlcTime, `each OpLogEntry's .hlcTime is greater than the previous time`);
        previousHlcTime = entry.hlcTime;
      });

      const sharedWhere = { store: NO_KEYPATH_STORE, objectKey: key, prop: '' };
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, value: initialValue } });
    });
  });

  describe('store.put() proxy', () => {
    it(`works with single-value keyPath`, async () => {
      const key = 1;
      let foundTodo;
      let foundEntries;
      const initialTodo: TodoItem = { id: key, name: 'buy cookies', done: false };
      const change: Partial<TodoItem> = { done: true };
      const finalTodo: TodoItem = { ...initialTodo, ...change };

      await txCompletion(TODO_ITEMS_STORE, async (proxiedStore) => {
        throwOnReqError(proxiedStore.put(initialTodo));
      });

      await txCompletion(TODO_ITEMS_STORE, (proxiedStore) => {
        throwOnReqError(proxiedStore.put(change, key));
      });

      await txCompletion(TODO_ITEMS_STORE, async (proxiedStore, oplogStore) => {
        foundTodo = await onSuccess(proxiedStore.get(finalTodo.id));
        foundEntries = await onSuccess(oplogStore.getAll());
      });

      expect(foundTodo).to.deep.equal(finalTodo);

      let previousHlcTime = '';
      foundEntries.forEach((entry: OpLogEntry) => {
        assert(entry.hlcTime > previousHlcTime, `each OpLogEntry's .hlcTime is greater than the previous time`);
        previousHlcTime = entry.hlcTime;
      });

      const sharedWhere = { store: TODO_ITEMS_STORE, objectKey: key };
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'id', value: initialTodo.id } });
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'name', value: initialTodo.name } });
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'done', value: initialTodo.done } });
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'done', value: finalTodo.done } });
    });

    it(`works with array keyPath`, async () => {
      const initial: ScopedSetting = { scope: 'foo', name: 'bar', value: 'baz' };
      const key = [initial.scope, initial.name];
      const change: Partial<ScopedSetting> = { value: 'boo' };
      const final = { ...initial, ...change };

      let foundSetting;
      let foundEntries;

      await txCompletion(ARR_KEYPATH_STORE, (proxiedStore) => {
        proxiedStore.put(initial);
      });

      await txCompletion(ARR_KEYPATH_STORE, (proxiedStore) => {
        proxiedStore.put(change, key);
      });

      await txCompletion(ARR_KEYPATH_STORE, async (store, oplogStore) => {
        foundSetting = await onSuccess(store.get(key));
        foundEntries = await onSuccess(oplogStore.getAll());
      });

      expect(foundSetting).to.deep.equal(final);

      foundEntries.forEach((entry: OpLogEntry) => {
        expect(entry.objectKey).to.deep.equal([foundSetting.scope, foundSetting.name]);
      });

      const sharedWhere = { store: ARR_KEYPATH_STORE, objectKey: key };
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'scope', value: initial.scope } });
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'name', value: initial.name } });
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'value', value: initial.value } });
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'value', value: final.value } });
    });

    it(`works without a keyPath`, async () => {
      const key = 'foo';
      const initialValue = 'bar';
      const finalValue = 8675309;
      let foundValue;
      let foundEntries;

      // Add the initial value to the store...
      await txCompletion(NO_KEYPATH_STORE, (proxiedStore) => {
        proxiedStore.put(initialValue, key);
      });

      // Read the initial value back from the store...
      await txCompletion(NO_KEYPATH_STORE, async (store, oplogStore) => {
        foundValue = await onSuccess(store.get(key));
      });

      // Verify that we found the initial value...
      expect(foundValue).to.deep.equal(initialValue);

      // Update the value...
      await txCompletion(NO_KEYPATH_STORE, (proxiedStore) => {
        proxiedStore.put(finalValue, key);
      });

      // Read it back out...
      await txCompletion(NO_KEYPATH_STORE, async (store, oplogStore) => {
        foundValue = await onSuccess(store.get(key));
      });

      // Verify that it has the expected value...
      expect(foundValue).to.deep.equal(finalValue);

      // Get all the oplog entries...
      await txCompletion(NO_KEYPATH_STORE, async (store, oplogStore) => {
        foundEntries = await onSuccess(oplogStore.getAll());
      });

      let previousHlcTime = '';

      foundEntries.forEach((entry: OpLogEntry) => {
        assert(entry.hlcTime > previousHlcTime, `each OpLogEntry's .hlcTime is greater than the previous time`);
        previousHlcTime = entry.hlcTime;
      });

      const sharedWhere = { store: NO_KEYPATH_STORE, objectKey: key, prop: '' };
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, value: initialValue } });
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, value: finalValue } });
    });
  });
});

function txCompletion(storeName: string, callback: (proxiedStore: IDBObjectStore, oplogStore: IDBObjectStore) => void) {
  return resolveOnTxComplete([storeName, IDBSideSync.OPLOG_STORE], 'readwrite', (store, oplogStore) => {
    const proxiedStore = IDBSideSync.proxyStore(store);
    callback(proxiedStore, oplogStore);
  });
}
