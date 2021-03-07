import { HLTime } from '../../src/HLTime';
import * as IDBSideSync from '../../src/index';
import { HLClock, OPLOG_STORE } from '../../src/index';
import {
  assertEntries,
  deleteDb,
  getDb,
  GLOBAL_SETTINGS_STORE,
  SCOPED_SETTINGS_STORE,
  TODOS_DB,
  TODO_ITEMS_STORE,
  transaction,
  waitForAFew,
} from './utils';

context('db', () => {
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

  describe('applyOplogEntry()', () => {
    it('throws error when passed an invalid oplog entry object', async () => {
      let caughtError;
      try {
        //@ts-ignore
        await IDBSideSync.applyOplogEntry({});
      } catch (error) {
        caughtError = error;
      }
      assert(
        caughtError instanceof IDBSideSync.InvalidOpLogEntryError,
        `Should throw error of type InvalidOpLogEntryError`
      );
    });

    it(`works when target store has an array keyPath`, async () => {
      const expectedSettingObj: ScopedSetting = {
        scope: 'defaults',
        name: 'theme',
        bgColor: 'blue',
      };
      let foundSettingObj;
      const objectKey = [expectedSettingObj.scope, expectedSettingObj.name];

      await IDBSideSync.applyOplogEntry({
        hlcTime: '2021-01-24T13:23:14.203Z-0000-testnode',
        objectKey: objectKey,
        prop: 'bgColor',
        store: SCOPED_SETTINGS_STORE,
        value: 'blue',
      });

      await transaction([SCOPED_SETTINGS_STORE], async (proxiedStore) => {
        foundSettingObj = await IDBSideSync.utils.request(proxiedStore.get(objectKey));
      });
      expect(foundSettingObj).to.deep.equal(expectedSettingObj);
    });

    it(`works when target store has single-value keyPath`, async () => {
      let foundTodo;
      const objectKey = 123;
      const expected = { id: objectKey, name: 'foo ' };

      await IDBSideSync.applyOplogEntry({
        hlcTime: '2021-01-24T13:23:14.203Z-0001-testnode',
        objectKey: objectKey,
        prop: 'name',
        store: TODO_ITEMS_STORE,
        value: expected.name,
      });

      await transaction([TODO_ITEMS_STORE], async (proxiedStore) => {
        foundTodo = await IDBSideSync.utils.request(proxiedStore.get(objectKey));
      });

      expect(foundTodo).to.deep.equal(expected);
    });

    it('ignores oplog entry if a newer one exists', async () => {
      const objectKey = 123;
      const olderEntry = {
        hlcTime: '2021-01-24T13:23:14.203Z-0000-testnode',
        objectKey: objectKey,
        prop: 'name',
        store: TODO_ITEMS_STORE,
        value: 'old',
      };
      const newerEntry = { ...olderEntry, hlcTime: '2021-01-24T13:23:14.203Z-0001-testnode', value: 'new' };
      let foundTodo;
      let foundEntries;

      await IDBSideSync.applyOplogEntry(newerEntry);
      await IDBSideSync.applyOplogEntry(olderEntry);

      await transaction([TODO_ITEMS_STORE], async (proxiedStore, oplogStore) => {
        foundTodo = await IDBSideSync.utils.request(proxiedStore.get(objectKey));
        foundEntries = await IDBSideSync.utils.request(oplogStore.getAll());
      });

      // The older entry should not have been added to the collection of entries
      expect(foundEntries).to.have.length(1);
      expect(foundTodo).to.deep.equal({ id: objectKey, name: newerEntry.value });
    });

    it('advances local HL clock time to be more recent than oplog entry HLC timestamp', async () => {
      IDBSideSync.HLClock.setTime(new HLTime(Date.now(), 0, 'thisnode'));

      let oplogEntry: OpLogEntry = {
        hlcTime: '',
        objectKey: 123,
        prop: 'name',
        store: TODO_ITEMS_STORE,
        value: 'foo',
      };

      const applyEntryTest = async () => {
        let hlNow = IDBSideSync.HLClock.time();

        // Set entry's time to some point in the future (within clock drift threshold)
        oplogEntry.hlcTime = new HLTime(Date.now() + HLClock.maxDrift, 0, 'thisnode').toString();

        // Expect our local HL clock to have a time that occurs before the entry's time
        assert(hlNow.toString() < oplogEntry.hlcTime, `Expected local HL clock time that occurs BEFORE entry time`);

        // Applying the oplog entry with a more recent HL time should cause our own clock to be advanced.
        await IDBSideSync.applyOplogEntry(oplogEntry);

        // Verify that the local clock time was moved beyond that of the oplog entry
        hlNow = IDBSideSync.HLClock.time();
        assert(oplogEntry.hlcTime < hlNow.toString(), `Expected HL clock time to have been moved beyond entry time`);
      };

      await applyEntryTest();

      await waitForAFew();
      await applyEntryTest();

      await waitForAFew();
      await applyEntryTest();
    });

    it('works when multiple entries affect same object in store with a keyPath', async () => {
      const expectedTodo: TodoItem = { id: 1, name: 'buy cookies', done: false };
      const todoOplogEntries = [
        {
          hlcTime: '2021-01-24T13:23:14.203Z-0000-testnode',
          objectKey: expectedTodo.id,
          prop: 'id',
          store: TODO_ITEMS_STORE,
          value: expectedTodo.id,
        },
        {
          hlcTime: '2021-01-24T13:23:14.203Z-0001-testnode',
          objectKey: expectedTodo.id,
          prop: 'name',
          store: TODO_ITEMS_STORE,
          value: expectedTodo.name,
        },
        {
          hlcTime: '2021-01-24T13:23:14.203Z-0002-testnode',
          objectKey: expectedTodo.id,
          prop: 'done',
          store: TODO_ITEMS_STORE,
          value: expectedTodo.done,
        },
      ];
      let foundTodo;
      let foundEntries;
      const sharedWhere = { store: TODO_ITEMS_STORE, objectKey: expectedTodo.id };

      for (let i = 0; i < todoOplogEntries.length; i++) {
        const entry = todoOplogEntries[i];

        await IDBSideSync.applyOplogEntry(entry);

        await transaction([TODO_ITEMS_STORE], async (proxiedStore, oplogStore) => {
          foundTodo = await IDBSideSync.utils.request(proxiedStore.get(expectedTodo.id));
          foundEntries = await IDBSideSync.utils.request(oplogStore.getAll());
        });

        expect(foundEntries).to.have.length(i + 1);
        assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: entry.prop } });
        expect(foundTodo).to.have.property(entry.prop, entry.value);
      }

      await transaction([TODO_ITEMS_STORE], async (proxiedStore) => {
        foundTodo = await IDBSideSync.utils.request(proxiedStore.get(expectedTodo.id));
      });
      expect(foundTodo).to.deep.equal(expectedTodo);
    });

    it('works when multiple entries affect same object in store without a keyPath', async () => {
      const objectKey = [111, 222];
      const sharedWhere = { store: GLOBAL_SETTINGS_STORE, objectKey: objectKey };
      let foundObj;
      let foundEntries;

      const oplogEntries = [
        {
          hlcTime: '2021-01-24T13:23:14.203Z-0000-testnode',
          objectKey: objectKey,
          prop: 'foo',
          store: GLOBAL_SETTINGS_STORE,
          value: 'bar',
        },
        {
          hlcTime: '2021-01-24T13:23:14.203Z-0001-testnode',
          objectKey: objectKey,
          prop: 'meaning',
          store: GLOBAL_SETTINGS_STORE,
          value: 42,
        },
        {
          hlcTime: '2021-01-24T13:23:14.203Z-0002-testnode',
          objectKey: objectKey,
          prop: 'foo',
          store: GLOBAL_SETTINGS_STORE,
          value: 'baz',
        },
      ];

      for (const entry of oplogEntries) {
        await IDBSideSync.applyOplogEntry(entry);
      }

      await transaction([GLOBAL_SETTINGS_STORE], async (proxiedStore, oplogStore) => {
        foundObj = await IDBSideSync.utils.request(proxiedStore.get(objectKey));
        foundEntries = await IDBSideSync.utils.request(oplogStore.getAll());
      });

      expect(foundObj).to.deep.equal({ meaning: 42, foo: 'baz' });
      assertEntries(foundEntries, { hasCount: 1, where: { ...sharedWhere, prop: 'meaning' } });
      assertEntries(foundEntries, { hasCount: 2, where: { ...sharedWhere, prop: 'foo' } });
    });
  });

  describe('getEntries()', async () => {
    const dummyEntryCount = 50;
    const firstEntryTime = Date.parse('2021-03-01T20:00:00.000Z');

    function firstEntryTimePlus(msec: number): Date {
      return new Date(firstEntryTime + msec);
    }

    beforeEach(async () => {
      console.log(`Inserting ${dummyEntryCount} dummy objects into ${OPLOG_STORE}.`);
      await transaction([], (oplogStore) => {
        for (let i = 1; i <= dummyEntryCount; i++) {
          oplogStore.add({
            hlcTime: `${new Date(firstEntryTime + i - 1).toISOString()}-0000-testnode`,
            objectKey: i,
            prop: 'foo',
            store: TODO_ITEMS_STORE,
            value: 'bar',
          });
        }
      });
    });

    it('returns expected when no parameters are specified', async () => {
      let entries = await IDBSideSync.getEntries();
      expect(entries).to.have.lengthOf(5);
    });

    it('paginates results correctly', async () => {
      const pageSize = 10;
      for (let page = 0; page < 5; page++) {
        let entries = await IDBSideSync.getEntries({ page, pageSize });
        expect(entries).to.have.lengthOf(10);
        let absolutePosition = page * pageSize;
        expect(entries[0].hlcTime).contains(firstEntryTimePlus(absolutePosition).toISOString());
        expect(entries[9].hlcTime).contains(firstEntryTimePlus(absolutePosition + pageSize - 1).toISOString());
      }
    });

    it('returns expected when min date is specified', async () => {
      const minDate = firstEntryTimePlus(10);
      let entries = await IDBSideSync.getEntries({ afterTime: minDate, page: 0, pageSize: 5 });
      expect(entries).to.have.lengthOf(5);
      expect(entries[0].hlcTime).contains(minDate.toISOString());
    });
  });
});
