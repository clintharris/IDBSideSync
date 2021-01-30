import * as IDBSideSync from '../../src/index';
import * as oplog_entries from '../fixtures/oplog_entries.json';
import { deleteDb, getDb, TODOS_DB, TODO_ITEMS_STORE } from './utils';

context('IDBSideSync:db', () => {
  beforeEach(async () => {
    await deleteDb();
    const db = await getDb();
    await IDBSideSync.init(db);
  });

  afterEach(async () => {
    // Always attempt to close the db after each test. If we don't do this and Cypress loads+runs another test file
    // after this one, then this file would not have closed the database, and the next file has no way to access the
    // same database reference--so it can't call db.close() either. That can happen because while the utils.ts caches
    // the database reference using the `dbPromise` variable, Cypress running another test file means loading that
    // utils.ts file a second time; a totally separate, second `dbPromise` variable is defined for that test file.
    (await getDb())?.close();
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
    expect(IDBSideSync.HLClock.time).to.exist;

    const db = await getDb();
    const txReq = db.transaction(IDBSideSync.STORE_NAME.META, 'readonly');
    const metaStore = txReq.objectStore(IDBSideSync.STORE_NAME.META);
    const getReq = metaStore.get(IDBSideSync.CACHED_SETTINGS_OBJ_KEY);

    const settings: Settings = (await IDBSideSync.utils.request(getReq)) as Settings;
    expect(settings).to.exist;
    expect(settings).to.have.property('nodeId');
    expect(settings.nodeId).not.to.be.empty;
  });

  it('applyOplogEntries() works', async () => {
    //TODO

    // const db = await getDb();

    // await IDBSideSync.init(db);
    // console.log('oplog_entries:', oplog_entries);
    // // await IDBSideSync.applyOplogEntries(oplog_entries);
    // expect(true).to.be.true;
  });
});
