const TODO_TYPES = 'todo_types';
const TODO_ITEMS = 'todo_items';
const TODO_ITEMS_BY_TYPE_INDEX = 'todo_items-index_by_type';
let db;

/**
 * Convenience function for getting a (cached/singleton) reference to an IndexedDB database via Promise. Mostly copied
 * from https://preview.tinyurl.com/yaoxc9cl).
 *
 * @returns a Promise that eventually resolves to the database.
 */
function getDB() {
  if (!db) {
    db = new Promise((resolve, reject) => {
      const openreq = indexedDB.open('todo-app', 1);

      openreq.onerror = () => {
        reject(openreq.error);
      };

      openreq.onupgradeneeded = (event) => {
        const db = event.target.result;
        sidesync.setupStores(db);
        db.createObjectStore(TODO_TYPES, { keyPath: 'id' });
        const todosStore = db.createObjectStore(TODO_ITEMS, { keyPath: 'id' });
        todosStore.createIndex(TODO_ITEMS_BY_TYPE_INDEX, 'type', { unique: false });
      };

      openreq.onsuccess = () => {
        resolve(openreq.result);
      };
    });
  }
  return db;
}

/**
 * Convenience function for initiating an IndexedDB transaction and getting a reference to an object store. Mostly
 * copied from https://preview.tinyurl.com/yaoxc9cl).
 *
 * @param {string} storeName - name of object store to retrieve
 * @param {string} mode - "readonly" | "readwrite"
 * @param {function} callback - will be called, with the object store as the first parameter.
 *
 * @returns a Promise that will resolve once the transaction completes successfully.
 */
async function withStore(storeName, mode, callback) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    // The flow of execution might be a bit confusing here; it basically works like this:
    // 1. Open/start the transaction.
    // 2. Assign event handlers for when the transaction finishes/fails.
    // 3. Execute the callback, passing in the object store.
    // 4. When the transaction is complete, resolve the promise.
    const transactionRequest = db.transaction(storeName, mode);
    transactionRequest.oncomplete = () => resolve();
    transactionRequest.onerror = () => reject(transactionRequest.error);
    callback(transactionRequest.objectStore(storeName));
  });
}

async function addTodo(todo) {
  let req;
  await withStore(TODO_ITEMS, 'readwrite', (store) => {
    req = store.add({ id: uuidv4(), ...todo });
  });

  return req.result;
}

async function updateTodo(params, id) {
  let req;
  await withStore(TODO_ITEMS, 'readwrite', (store) => {
    req = store.put(params, id);
  });

  return req.result;
}

function deleteTodo(id) {
  return updateTodo({ tombstone: 1 }, id);
}

function undeleteTodo(id) {
  return updateTodo({ tombstone: 0 }, id);
}

async function getAllTodos() {
  let req;
  await withStore(TODO_ITEMS, 'readonly', (store) => {
    req = store.getAll();
  });
  return req.result.filter((todo) => todo.tombstone !== 1);
}

async function getTodo(id) {
  let req;
  await withStore(TODO_ITEMS, 'readonly', (store) => {
    req = store.get(id);
  });
  return req.result;
}

async function getDeletedTodos() {
  let req;
  await withStore(TODO_ITEMS, 'readonly', (store) => {
    req = store.getAll();
  });
  return req.result.filter((todo) => todo.tombstone === 1);
}

async function getNumTodos() {
  let req;
  await withStore(TODO_ITEMS, 'readonly', (store) => {
    req = store.count();
  });
  return req.result;
}

async function getTodoTypes() {
  let req;
  await withStore(TODO_TYPES, 'readonly', (store) => {
    req = store.getAll();
  });
  return req.result;
}

async function addTodoType({ name, color }) {
  let req;
  await withStore(TODO_TYPES, 'readwrite', (store) => {
    req = store.add({ id: uuidv4(), name, color });
  });
  return req.result;
}

async function deleteTodoType(typeId, newTypeId) {
  // First, delete or migrate the todo's of the type that's about to be deleted.
  await withStore(TODO_ITEMS, 'readwrite', (store) => {
    const todosByTypeIndex = store.index(TODO_ITEMS_BY_TYPE_INDEX);
    const req = todosByTypeIndex.openCursor(IDBKeyRange.only(typeId));
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if(cursor) {
        const todo = cursor.value;
        if (todo.type === typeId) {
          if (newTypeId) {
            console.log(`🔄 migrating todo to type ${newTypeId}:`, todo);
            //TODO: proxy cursor to support partial update()
            cursor.update({ type: newTypeId });
          } else {
            console.log('🗑 deleting todo:', todo);
            cursor.delete();
          }
        } else {
          console.warn(`🤔 Found todo with typeId !== ${typeId} but shouldn't have since cursor was opened with query`);
        }
        cursor.continue();
      }
    }
  });

  // Now delete the todo type.
  await withStore(TODO_TYPES, 'readwrite', (store) => {
    store.delete(typeId);
  });
}
