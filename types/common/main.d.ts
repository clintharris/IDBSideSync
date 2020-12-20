/**
 * Objects with this shape respresent a recorded data mutation that took place at some time, on some node, as specified
 * by the Hybrid Logical Clock timestamp (`hlcTime`). When shared with another node, it should be possible to identify
 * the affected object store (and object if it exists), and apply the same mutation (i.e., re-create the operation).
 *
 * For example:
 * 1. A 'users' object store exists with `keyPath = 'userId'`.
 * 2. An object exists: `{ userId: 123, name: 'Spongebob' }`
 * 3. An update happens: `store.put({ userId: 123, name: 'Gary' })`
 * 4. This is recorded as an oplog entry:
 *    { hlcTime: ..., field: 'store=users&objectKeys[userId]=123field=name', value: ... }
 *
 * Note that the `field` value is a URL-encoded string that identifies which store, object (i.e., the property and value that can be used to find the object in the store), and field of the object is affected by the operation. These identifying bits of information are stored in a single string, not as separate, first-class properties of the OpLogEntry object, so that it's possible to quickly find all of the entries for a specific store/object/field using only a single string. This kind of search is a common task when trying to find the most recent OpLogEntry for a specific field.
 *
 * The 'field' value is URL-encoded to make it more convenient to parse into an object.
 *
 *
 * having everything in a single string, it's much easier to query the IndexedDB object store that keeps all the oplog
 * objects, asking for the most recent oplog entry for a specific field: you just get all the objects that have the
 * matching 'field' value, then use a cursor to find the one with the max '
 *
 *
 * Note that object stores can be set up where the `keyPath` is an array of prop names. For example:
 * 1. A 'pets' object store exists with `keyPath = ['fName', 'lName']`.
 * 2. An object exists: `{ fName: 'Gary', lName: 'Squarepants', age: 5 }`
 * 3. An update happens: `store.put({ fName: 'Gary', lName: 'Squarepants', age: 7 })`
 * 4. This is recorded as an oplog entry:
 *    { field: 'store=pets&objectKeys[fName]=Gary&objectKeys[lName]=Squarepants&field=age', hlcTime: ..., value: ... }
 */
interface OpLogEntry {
  hlcTime: string;
  store: string;
  key: IDBValidKey;
  field: string;
  value: unknown;
}
