# Overview

IDBSideSync is a JavaScript library/experiment that makes it possible to sync IndexedDB object stores using [CRDT](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type) concepts. It works by intercepting the CRUD calls to IndexedDB stores and automatically logging all the operations "on the side" in a separate store--the operation log. The objects in the operation log ("oplog entries") can be copied and "replayed" somewhere else to (eventually) synchronize IndexedDB databases across devices without conflict.

You could use this library to, for example, build a "[local first](https://www.inkandswitch.com/local-first.html)" [PWA](https://developer.mozilla.org/en-US/docs/Web/Apps/Progressive/) that optionally syncs across devices without having to run a custom server application. IDBSideSync allows plugins to be used to add support for syncing data with different HTTP-accessible remote storage APIs (e.g., Google Drive). This "bring your own server" model allows users to maintain ownership of their data even while it is on a server--and gives them the flexibility change to a different remote storage service at any time. The data is sync'ed as simple JSON text files (CRDT messages), easily usable by other software which helps give users the option to "[bring [their] own client](https://www.geoffreylitt.com/2021/03/05/bring-your-own-client.html)".

The idea for the library came from studying [James Long](https://twitter.com/jlongster)'s
[crdt-example-app](https://github.com/jlongster/crdt-example-app), which offers a great intro to CRDT concepts. `IDBSideSync` is an attempt at applying those concepts (and in some cases, modified versions of James' code) in a different direction, with a goal of letting in-browser app developers use [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) as they normally would while CRDT messages are maintained and synchronized "on the side" (notably, using HTTP-accessible data storage that non-technical users already have instead using a developer-managed server or service). `IDBSideSync` was deliberately forked from `crdt-example-app` to make that "heritage" literally part of this project's own history.

# ⚠️ Disclaimer

IDBSideSync is still experimental and under development. Some parts of it have not been tested, some things are incomplete, etc. It is not ready for production.

# Who is this for?

App developers who want to build PWA's that use IndexedDB for the local database and still have the ability to sync across devices.

Don't like IndexedDB? Take a look at Jake Archibald's fantastic [idb](https://github.com/jakearchibald/idb) library--it makes using IndexedDB a easier.

# How it Works

## The "OpLog": creating "something changed" messages on the side

## Remote Sync: use whatever remote storage service the user has

A guiding objective for remote sync is: meet the user where they are (i.e., with whatever hosted provider account they already have), and avoid asking them to create a new account.

# Usage

```
npm install --save idbsidesync
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
todoStore.put({ title: "Buy cookies", priority: "high", done: false }, todoId);

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

# Sync

The idea with syncing is to somehow copy oplog entries from one client (i.e., an instance of your app, running in a browser) to another client, where they can then be "replayed" (or applied) another IndexedDB object stores.

The core IDBSideSync library is built to work with one or more sync plugins. In other words, instead of hard-coding in logic about how to sync with Google Drive, for example, it offers a way for you to register a separate class or object that has that logic--a plugin.

TODO: info on the plugin interface and how to register a custom plugin with IDBSideSync.

# FAQ

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

### Q: Is the remote syncing mechanism resilient tampering?

Any entity that has access to the oplog entry data while stored on a remote file system has the ability to alter those CRDT messages. Ganting an entity access to a data store used for remote sync implies trusting that entity. In other words, the remote syncing store--usually something like a shared folder within Dropbox or Google Drive--should only be shared with people you trust.

That said, it would be nice to detect (and possibly fix) accidental deletion or alteration of oplog entry data. This feature is planned as part of Issue #4.

# Contributing

Want to submit a PR for adding a new feature or bugfix? Or maybe you just want to create a new fork that demonstrates an issue? Do all this and more with just a few clicks using the amazing Contrib-o-matic™️ process (_actual clicks and results may vary_):

1. [Click here](https://codesandbox.io) to create a fully working, forked, project dev environment.
2. Modify the project.
3. Submit a PR.
4. CodeSandbox CE will automatically build an installable version of the library from your PR and create a new Sandbox in which your fix/improvement can be tested.
