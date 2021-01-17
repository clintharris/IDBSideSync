import * as IDBSideSync from '../../src/index';

const TODOS_DB = 'todos-db';
const TODOS_STORE = 'todos-store';
let dbPromise: Promise<IDBDatabase> | null = null;

context('IDBSideSync:db', () => {
  beforeEach(() => {
    return clearDb();
  });

  it(`onupgradeneeded() creates expected object stores and indices.`, async () => {
    const db = await getDb();
    expect(db.name).to.equal(TODOS_DB);
    expect(db.objectStoreNames.contains(IDBSideSync.OPLOG_STORE)).equals(true);
    expect(db.objectStoreNames.contains(IDBSideSync.STORE_NAME.META)).equals(true);

    const txReq = db.transaction(IDBSideSync.OPLOG_STORE, 'readonly');
    const storeReq = txReq.objectStore(IDBSideSync.OPLOG_STORE);
    const indexReq = storeReq.index(IDBSideSync.OPLOG_INDEX);
    expect(indexReq.name).to.equal(IDBSideSync.OPLOG_INDEX);
  });

  it('init() initializes all settings', async () => {
    // expect.assertions(1);
    const db = await getDb();
    await IDBSideSync.init(db);

    expect(IDBSideSync.HLClock.time).to.exist;

    const txReq = db.transaction(IDBSideSync.STORE_NAME.META, 'readonly');
    const metaStore = txReq.objectStore(IDBSideSync.STORE_NAME.META);
    const getReq = metaStore.get('settings');
    const settings: Settings = await onSuccess(getReq) as Settings;
    expect(settings).to.have.property('nodeId');
    expect(settings.nodeId).not.to.be.empty;
  });
});

function onSuccess(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = (event) => {
      reject(event);
    };
  });
}

async function clearDb() {
  // If a database connection is open, the attempt to delete it will fail. More specifically, the attempt to delete will
  // be "blocked" and the `onblocked` callback will run.
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }

  return new Promise((resolve, reject) => {
    const deleteReq = indexedDB.deleteDatabase(TODOS_DB);

    deleteReq.onsuccess = (event) => {
      resolve(deleteReq.result);
    };

    deleteReq.onerror = (event) => {
      reject(new Error(`Couldn't delete "${TODOS_DB}" DB between tests; 'onerror' event fired`));
    };

    deleteReq.onblocked = (event) => {
      reject(new Error(`Couldn't delete "${TODOS_DB}" DB between tests; This could mean a db conn is still open.`));
    };
  });
}

async function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const openreq = indexedDB.open(TODOS_DB, 1);

      openreq.onerror = (event) => {
        reject(openreq.error);
      };

      openreq.onupgradeneeded = (event) => {
        const db = openreq.result;
        IDBSideSync.onupgradeneeded(event);
        db.createObjectStore(TODOS_STORE, { keyPath: 'id' });
      };

      openreq.onblocked = (event) => {
        reject(event);
      };

      openreq.onsuccess = (event) => {
        resolve(openreq.result);
      };
    });
  }
  return dbPromise;
}
