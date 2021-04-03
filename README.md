# Overview

IDBSideSync is a JavaScript library/experiment that makes it possible to sync IndexedDB object stores using CRDT concepts. It works by intercepting the CRUD calls to IndexedDB stores and automatically logging all the operations "on the side" in a separate store--the operation log. The objects in the operation log can be uploaded somewhere, then downloaded and "replayed" somewhere else, in effect, synchronizing IndexedDB databases across devices without conflict.

You can use this library to, for example, build a "[local first](https://www.inkandswitch.com/local-first.html)" [PWA](https://developer.mozilla.org/en-US/docs/Web/Apps/Progressive/) that also supports syncing across different devices without having to run a custom server application. Once a user enables a remote file storage API (e.g., Google Drive, Dropbox, iCloud, or something else via custom plugin), the application can use that store for backup and sync. This "bring your own remote data store" model allows users to maintain ownership of their data--even while it is on a server--and gives them the flexibility change to a different remote storage service at any time. The CRDT messages are stored as simple JSON text files, easily usable by other software.

The idea for the library came from studying [James Long](https://twitter.com/jlongster)'s
[crdt-example-app](https://github.com/jlongster/crdt-example-app), which offers a fantastic demonstration of how to use [CRDT](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type), [hybrid logical clock](https://jaredforsyth.com/posts/hybrid-logical-clocks/), and merkle tree concepts to build a simple, in-memory data store that uses a custom server for synchronization. `IDBSideSync` is an attempt at applying those concepts (and in some cases, modified versions of James' code) to work with [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API), specifically. It also adds the ability for HTTP-accessible data storage APIs that users already have (or host themselves) as the means for syncing data instead of relying on a single, developer-owned, server application. `IDBSideSync` was deliberately forked from `crdt-example-app` to make that "heritage" literally part of this project's own history.

# ⚠️ Disclaimer

IDBSideSync is still experimental and under development. Some parts of it have not been tested, some things are incomplete, etc. It is not ready for production.

# Usage

```
npm install --save @clintharris/IDBSideSync
```

First, you'll need to add a few lines to your existing IndexedDB setup code for initializing `IDBSideSync`:

```javascript
const openreq = indexedDB.open("todo-app", 1);

openreq.onupgradeneeded = (event) => {
  const db = event.target.result;

  // ⛔️ Note that IDBSideSync does NOT support object stores with the autoIncrement option. This
  //  is because if IndexedDB were allowed to auto-assign the "keys" for objects, there would be
  // no guarantee of uniqueness.
  //
  // ⛔️ Also, IDBSideSync doesn't currently support "nested" keyPath values (e.g., `keyPath: 'foo.bar'`).
  const todosStore = db.createObjectStore("todos", { keyPath: "id" });

  // Give IDBSideSync a chance to create its own object stores and indices.
  IDBSideSync.onupgradeneeded(event);
};

openreq.onsuccess = () => {
  // Now that the object stores exist, allow IDBSideSync to initiailize itself before using it.
  IDBSideSync.init(openreq.result);
};
```

## Adding Stuff

Now just make sure to use an "IDBSideSync wrapped" version of the IndexedDB object store so that data mutations can be intercepted and recorded in the background as you perform CRUD operations on your data:

```javascript
// Make sure to include IDBSideSync's OPLOG_STORE in the transaction (otherwise it won't be able
// to commit/rollback its own operation log changes as part of the same transaction).
const txRequest = db.transaction(
  ["todos", IDBSideSync.OPLOG_STORE],
  "readwrite"
);
const todoStore = IDBSideSync.proxyStore(txRequest.objectStore("todos"));

// You need to ensure that object keys are unqiue. One option is to use  IDBSideSync's `uuid()`
// convenience function.
const todoId = IDBSideSync.uuid(); // 123
todoStore.add({ id: todoId, title: "Buy milk" }); // { id: 123, title: "Buy milk" }
```

## Updating Stuff

IDBSideSync, acting as a [JavaScript proxy](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy) to the standard [`IDBObjectStore.put()`](https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/put) function, modifies the default behavior of `put()` so that it no longer completely replaces any existing object with the value you pass to it. Instead, you now have the ability to pass in "partial updates"--objects with only a subset of properties--that will be applied to any existing object. (You can still pass in complete objects with all properties if you want, of course.)

```javascript
// Assuming a full todo object looks like `{ id: 123, title: "Buy cookies", priority: "low", done: false }`, let's say
// the user just changed its priority from "low" to "high"...
todoStore.put({ priority: "high" }, todoId); // 👍 Only update the prop that was changed: GOOD.

// In a separate transaction...
todoStore.get(todoId).onsuccess = (event) => {
  console.log(event.target.result); // { id: 123, title: "Buy cookies", priority: "high", done: false }
};
```

### ⚠️ Make object you pass to put() as minimal as possible!

When possible, only pass in an object with props/values that you have actually changed. This helps ensure that your changes, and the changes that might be made to the same object somewhere else, are _merged_.

If, instead, if you pass in a "complete" version of an object with all the properties--including ones you didn't modify--you may end up overwriting changes that were made to a specific prop somewhere else.

```javascript
// 👎 User only changed priority, but let's update all the props anyways: BAD
todoStore.put({ title: "Buy cookies" , priority: "high", done: false }, todoId);

// In a separate transaction...
todoStore.get(todoId).onsuccess = (event) => {
  // 😭 If someone else had previously marked this todo as "done", their change will be lost once they receive these
  // changes since an operation log entry was just created that overwrites all props on the todo--including the "done"
  // property.
  console.log(event.target.result); // { id: 123, title: "Buy cookies", priority: "high", done: false }
};
```

## Deleting stuff

For now, IDBSideSync doesn't support the deletion of things (although this might be a feature in the future). Don't do the following things, for example:

```javascript
const todoStore = IDBSideSync.proxyStore(txRequest.objectStore("todos"));

// Don't do this...
todoStore.delete(todoId); // ❌

// ...or this
todoStore.openCursor().onsuccess = function (event) {
  const cursor = event.target.result;
  cursor.delete(); // ❌
};

// ...or this
const todoIndex = todoStore.index("todos_indxed_by_title");
todoIndex.openCursor().onsuccess = function (event) {
  const cursor = event.target.result;
  cursor.delete(); // ❌
};
```

In fact, IDBSideSync might be modified at some point to throw errors if you do any of the stuff shown above to help prevent problems.

As a recommended alternative, do "soft" deletion of objects instead. In other words, update them with some sort of property that indicates they should be _treated_ as if they were deleted (e.g., `{ name: 'foo', deleted: 1 }`). Note that a nice benefit of this approach is that it's easy to support undo when objecs are "deleted".

# API

todo

## What types of object stores does it work with?

`IDBSideSync` does not support object stores that use `autoIncrement`. If IndexedDB is auto-assigning the object IDs, then it's possible for two separate clients to create an object with the same key/ID. In that scenario, there's no safe way to share and apply oplog entries (i.e., CRDT messages) since they might describe mutations that _appear_ to be relevant to the same object but actually could refer to different objects that have the same key/ID.

Also, `IDBSideSync` currently doesn't support `add(value, key)` or `put(value, key)` calls when `key` is of type `ArrayBuffer` or `DataView`.

## FAQ

### Q: But I really dislike the IndexedDB API...

Agreed: the IndexedDB's API isn't nearly as convenient as many popular relational or "document-oriented" databases. However, it's a pragmatic choice if you want a persistent data store API that is ubiquitous across most browsers.

Jake Archibald's [idb](https://github.com/jakearchibald/idb) library makes using IndexedDB a bit easier.

### Q: What happens if the same oplog/change message is "ingested" more than once?

It will have no effect on the data store. Message values are only applied to the data store if the message's HLC time is more recent than the current value.

However, it would "corrupt" the Merkle tree (if the tree weren't set up to prevent it) since the hash values would still change when the message's hash is inserted a second time.

### Q: Does it work with Jake Archibald's [idb](https://github.com/jakearchibald/idb) library?

Yes. You can pass a sidesync'ed object store to idb's `wrap()` function. Since `IDBSideSync` works as an invisible Proxy, idb won't know the difference.

### Q: Why does it add `IDBSideSync_*` object stores to my app's IndexedDB database?

IDBSideSync uses these stores to record all of the change operations (operation log entries) and keep track of internal things like information about how to sync with any remote storage services your app sets up (e.g., Google Drive).

These object stores need to live in your application's database so that the library can easily read and write to your app's object stores. More specifically, IDBSideSync needs to be able to include both its own stores _and_ your app's stores in the same IndexedDB transactions; this can only be done if the stores are in the same database.

# Contributing

Want to submit a PR for adding a new feature or bugfix? Or maybe you just want to create a new fork that demonstrates an issue? Do all this and more with just a few clicks using the amazing Contrib-o-matic™️ process (_actual clicks and results may vary_):

1. [Click here](https://codesandbox.io) to create a fully working, forked, project dev environment.
2. Modify the project.
3. Submit a PR.
4. CodeSandbox CE will automatically build an installable version of the library from your PR and create a new Sandbox in which your fix/improvement can be tested.

# Roadmap

- [ ] Find a way to add support for increment and array insert operations (currently only "set" is supported).
  - There's no good way to do this without deviating from the IndexedDB API (which really only supports "set" ops)
  - It would involve modifying the oplog entry objects to specify the _type_ of operation (set/increment/insert). Example:
      ```
      {
        hlcTime: '2021-01-24T13:23:14.203Z-0002-testnode',
        store: TODO_ITEMS_STORE,
        objectKey: defaultTodo.id,
        operation: 'increment' // 'set' | 'arrayInsert'
        prop: 'someCounter',
        value: -1
      }
      ```
  - Note that supporting array operations (i.e., insert, mutate at index, etc.) is not a pre-requisite! A feasible (and possibly simpler) solution is to normalize objects. Instead of `{ id: 1, things: [thing1, thing 2] }`, create a separate object collection for things and associate them with the parent object.
- [ ] Add Cypress tests that run against the example app UI
  - This would both help ensure that example app isn't broken with some changes and (bonus) also tests the library.
- [ ] Publish to NPM; take a look at [np](https://github.com/sindresorhus/np) (recommended by tsdx)
- [ ] Investigate using Chrome's Native File System API and using the local file system as one option for testing/developing oplog entries being "sync'ed". In other words, instead of worrying about the details of the Google Drive API, for example, just have two windows open that are both reading/writing to the same local drive--so a "shared local folder" is being used to sync the files.
- [ ] Modify Rollup to bundle murmurhash and uuid _with_ the library
  - see "https://www.mixmax.com/engineering/rollup-externals/" section of https://www.mixmax.com/engineering/rollup-externals/ for example of which rollup plugins to install and use
  - see https://tsdx.io/customization#example-adding-postcss for example of how to customize tsdx's rollup config to use rollup plugins
- [ ] Incorporate Jared Forsyth's HLC string formatting improvements that allow for longer timestamp and counter strings:
  - `physTime.toString().padStart(15, '0')` // 13 digits is enough for the next 100 years, so 15 is plenty
  - `count.toString(36).padStart(5, '0') // 5 digits base 36 is enough for more than 6 million "out of order" changes
  - https://jaredforsyth.com/posts/hybrid-logical-clocks/
- [ ] Add full integration test/simulation of messages from multiple nodes being processed
  - verify that event ordering is correct (i.e., that various table/row/column values end up with values specified by "most recent" corresponding operation)
  - this will require implementation of in-memory data store
  - how will this work without the use of the merkle tree for efficient diffing? is that even necessary?
  - make sure to prevent the "many changes in same ~10sec window causes issue" problem (https://twitter.com/jaredforsyth/status/1228366315569565696)
- [ ] Set up the project to work with [CodeSandbox CI](https://codesandbox.io/docs/ci).
- [ ] Add a [Code Tour](https://github.com/microsoft/codetour)
- [ ] Modify README structure to follow an "API Docs, Usage, Examples" structure like this: https://github.com/sql-js/sql.js
- [ ] Support _syncing_ with remote file storage services
  - Once a standard API exists for the _local_ data store (which can be implemented with different adapters), modify the sync code so that it uses a standard API, which would allow for different remote storage providers to be plugged in.
  - `sidesync-gdrive`, `sidesync-icloud`, etc.
  - each node (e.g., user-owned device) uploads every oplog entry to the server
  - each entry has a filename: the timestamp.toString() value
    - since every timestamp is unique, there shouldn't be any filename collisions
  - each node uploads (and updates) a JSONified version of their merkle tree
    - these merkle tree files should all have a standard extension to be easily discovered by via filename pattern searching (e.g., {nodeId}.merkle.json)
    - with GDrive API, you'd use a query like `name contains '.merkle.json.7z'`
  - a node can download the merkle trees from other nodes and diff _locally_ to more efficiently determine a _time_ at which the merkle trees began to differ
    - it can then download and ingest all oplog entries on/after that time
  - each node updates and uploads an "index" file: an _ordered_ list of all the HLC timestamps (i.e., filenames) for events _that node_ has created
    - these files should all have a standard extension to be easily discovered by via filename pattern searching (e.g., {nodeId}.index.txt)
    - this file should be uploaded to the server on each sync (overwriting the existing file if one exists)
    - other nodes can download this (pre-sorted) list and, after having compared merkle trees with this node to find a timestamp when they began to differ, iterate over (ordered) list of timestamps until it gets to the point where the divergence began--all filenames after that point in the list should be downloaded and processed.
    - these files could get BIG; adding 1M timestamps resulted in a 45MB text file
    - compression could help; this could be diferred to server and browser (assuming server compression is enabled), or _maybe_ done in the browser (JSZip compressed 45MB realistic text file to 134 KB in 1.2 sec)
    - another option that adds complexity is to chunk the indices, maybe putting timestamp ranges in index filenames to help decide which index to download (e.g., `{nodeId}.{firstTimeStamp__lastTimeStamp}.index.txt`)
  - Google Drive doesn't support searching/filtering by regex expressions, so it's probably necessary to:

    1. retrieve a list of _all_ filenames (and just the names--so we know what to try to download)
    2. parse/order that list and start downloading each file with filename after the diff time, OR
    3. OR just iterate over the full list (without sorting) and download each file as necessary
       - if there are thousands of files, this would more efficient since it's not necessary to load the entire list into memory (similar to using a DB cursor)

    - this could be done by "searching" for files using a filename pattern that will exclude oplog entries before some time (see https://stackoverflow.com/a/11011934/62694)
    - OR (maybe simpler but much less efficient), download all file _names_ (i.e., list dir), iterate over them (parsing each filename to an actual HLC time that can be compared to the reference HLC time), and download each one that occurs on/after the reference time.
  - [ ] Explore using JSZip to compress the oplog json. This can/should be done on a per-plugin basis; the core lib should not be doing anything 
  - [ ] Explore and document worst-case scenarios (e.g., what happens if a node's clock is off by hours/days?)
  - [ ] Support sharing/collaboration with other users

    To collaborate, the following is necessary:

    - all oplog entries have 0..1 remote location identifiers
    - when you download oplog entries from a remote location, it will have that remote's identifier
    - when you create an oplog entry, you will need to specify which remote it should be associated with
      - if you haven't set up a remote, the entry won't have a remote identifier
      - if you have set up 2+ remotes, you'll need to pick which remote it should be associated with
    - the sync function will only upload oplog entries to their specified remote (if one is set)
    - in a single-user app, the user will need to set up the same remote on each device to sync across devices
    - in a collaborative app, each user will need to set up a remote to which all users have read access, and at least one user has write access
      - example, a shared google drive folder
    - when a user decides to share an object, a NEW set of oplog entries should be created for all props of the object, with the specified remote identifier.
    - From that point on, all oplog entries for that destination are only uploaded to that destination.
    - other users will download those entries and recreate the object
    - the app on other users devices should know if the user has write access to the remote, and prevent the user from attempting to edit those objects (for good UX; note that permissions are enforced by remote storage service).
    - if you download oplog entries associated with a shared remote, an object will be created locally.


## Refactoring

- [ ] Consider increasing the allowed difference for clock times coming from other systems; only allowing for a 1-minute difference between any other clock in the distributed system seems like it could be error prone...
- [ ] Modify HLTime.parse() to do a better job of checking for issues with the passed-in string and throwing errors if necessary (e.g., throwing if an invalid month is specified)
- [ ] Merkle tree:
  - [ ] consider only allowing inserts to proceed for "full" 17-digit paths. This would prevent the possibility of setting hash value for non-leaf nodes (which would result in a node whose hash is, technically, not derived from the hashes of all its children). The downside of this is that it would make unit testing harder to easily understand (since you can't use "simple" testing trees with only a few nodes).


