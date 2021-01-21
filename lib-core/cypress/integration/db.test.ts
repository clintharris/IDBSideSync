import * as IDBSideSync from '../../src/index';
import * as oplog_entries from '../fixtures/oplog_entries.json';
import { clearDb, getDb, resolveRequest, TODOS_DB } from './utils';

context('IDBSideSync:db', () => {
  beforeEach(clearDb);

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
    const db = await getDb();

    await IDBSideSync.init(db);
    expect(IDBSideSync.HLClock.time).to.exist;

    const txReq = db.transaction(IDBSideSync.STORE_NAME.META, 'readonly');
    const metaStore = txReq.objectStore(IDBSideSync.STORE_NAME.META);
    const getReq = metaStore.get('settings');
    const settings: Settings = (await resolveRequest(getReq)) as Settings;
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
