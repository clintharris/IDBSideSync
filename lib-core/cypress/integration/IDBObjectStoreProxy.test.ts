import * as IDBSideSync from '../../src/index';
import { clearDb, getDb, TODO_ITEMS_STORE, txWithStore } from './utils';

context('IDBObjectStoreProxy', () => {
  beforeEach(async () => {
    await clearDb();
    const db = await getDb();
    await IDBSideSync.init(db);
  });

  it(`proxies store.add() correctly.`, async () => {
    const expectedTodo: TodoItem = { id: 1, name: 'buy cookies', done: false };

    await txWithStore([TODO_ITEMS_STORE, IDBSideSync.OPLOG_STORE], 'readwrite', (todoItemsStore, oplogStore) => {
      const proxiedStore = IDBSideSync.proxyStore(todoItemsStore);
      proxiedStore.add(expectedTodo);
    });

    let foundTodo;
    let foundOplogEntries;

    await txWithStore([TODO_ITEMS_STORE, IDBSideSync.OPLOG_STORE], 'readonly', (todoItemsStore, oplogStore) => {
      const proxiedStore = IDBSideSync.proxyStore(todoItemsStore);
      const getTodoReq = proxiedStore.get(expectedTodo.id);
      getTodoReq.onsuccess = () => {
        foundTodo = getTodoReq.result;
      };

      const getOplogEntriesReq = oplogStore.getAll();
      getOplogEntriesReq.onsuccess = () => {
        foundOplogEntries = getOplogEntriesReq.result;
      };
    });

    expect(foundTodo).to.deep.equal(expectedTodo);

    let previousHlcTime = '';

    foundOplogEntries.forEach((entry: OpLogEntry) => {
      assert(entry.hlcTime > previousHlcTime, `each OpLogEntry's .hlcTime is greater than the previous time`);
      assert(entry.store === TODO_ITEMS_STORE, `each OpLogEntry has expected .store`);
      assert(entry.objectKey === expectedTodo.id, `each OpLogEntry has expected .objectKey`);
      previousHlcTime = entry.hlcTime;
    });

    assert(find(foundOplogEntries, 'id').value === expectedTodo.id, 'OpLogEntry was created for .id prop');
    assert(find(foundOplogEntries, 'name').value === expectedTodo.name, 'OpLogEntry was created for .name prop');
    assert(find(foundOplogEntries, 'done').value === expectedTodo.done, 'OpLogEntry was created for .done prop');
  });
});

function find(entries: OpLogEntry[], prop: string): OpLogEntry | undefined {
  return entries.find((entry: OpLogEntry) => entry.prop === prop);
}
