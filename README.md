## Overview

IDBSideSync is an experimental JavaScript library that makes it possible to sync browser-based IndexedDB databases using [CRDT](https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type) concepts.

You could use this library to, for example, build an HTML/JavaScript app that allows users to sync their data across the browsers they use on different devices while allowing them to decide where their data is stored. In other words, instead of users sending their data to a service that you (the app developer) manages, you allow them to choose where their data is stored remotely to support syncing--preferably, a place where they already keep their stuff, such as Google Drive, GitHub, or another browser-accessible data store they trust.

The concept that IDBSideSync is attempting to prove is: local-first, browser-based apps can be built with support for sync and collaboration using CRDTs and remote stores that users have more control over--especially ones that can be managed via a user-friendly, file-system-like interface. An app that needs to handle a ton of data or support real-time collaboration among many users probably needs a more traditional backend or [DBaaS](https://en.wikipedia.org/wiki/Cloud_database). But there's a [category of end-user software](https://www.inkandswitch.com/local-first.html) where things can work primarily offline, without real-time sync, that might be improved by allowing users to "keep" their own data--that's probably a better fit for for something like IDBSideSync.

## How it works

- You have an HTML/JavaScript app that uses IndexedDB.
- We'll call each "user + browser + app" instance of your app a _client_.
- As your app makes [CRUD](https://en.wikipedia.org/wiki/Create,_read,_update_and_delete) calls to its IndexedDB database, IDBSideSync proxies/intercepts those calls and records the operations to a log (the "oplog").
- Your app registers a "sync plugin" (some JavaScript) with IDBSideSync; a plugin implements a standard interface and knows how to perform certain operations with that store (e.g., knows how to store and retrieve data using Google Drive's API).
- At some point, your app asks IDBSideSync to _sync_--maybe your app offers a "Sync" button or schedules it to happen automatically.
- IDBSideSync will upload the client's oplog entries (CRDT state mutation messages) to the remote data store using the registered plugins, and also download _other client's_ oplog entries--which then get applied to your app's database.
- A [hybrid logical clock](https://jaredforsyth.com/posts/hybrid-logical-clocks/) (i.e., time + counter) is maintained among the clients to help figure out which operations "win" if more than one exists for the same database store/record/property.

## Motivation, prior art

The idea for the library comes from wanting a way to build a browser-based app that can sync while allowing users to keep their data--no developer-managed backend needed--and from learning about CRDTs from [James Long](https://twitter.com/jlongster)'s
[crdt-example-app](https://github.com/jlongster/crdt-example-app). In fact, IDBSideSync forks from crdt-example-app and in some cases still uses modified versions of James' code. 

The decision to focus on using IndexedDB comes from wanting to be pragmmatic. Instead of needing to invent a whole new database API, why not just piggy back on one that already exists in every browser and try to add the ability for it to sync using CRDTs?

## Demo

You can try out a crude "to do" demo app that uses the library [here](todo).

The demo source can be found in [`app_demos/plainjs_todos`](./app_demos/plainjs_todos). Take a look at `main.js` and `db.js`, in particular, to see how things work.

Note that the goal of the "plain JS" app is to be a "framework agnostic" example of how to use IDBSideSync, without needing prior knowledge of a particular library like React. It's not meant to be efficient or very pretty, but hopefully it's easy to understand (and credit for the super-simple approach goes to James).

## Usage

```
npm install --save idbsidesync
```

### Setup

First, you'll need to add a few lines to your existing IndexedDB setup code for initializing `IDBSideSync`:

```javascript
const openRequest = indexedDB.open("todo-app", 1);

openRequest.onupgradeneeded = (event) => {
  const db = event.target.result;

  // ⛔️ Note that IDBSideSync does NOT support object stores with the autoIncrement option. This
  // is because if IndexedDB were allowed to auto-assign the "keys" for objects, there would be
  // no guarantee of uniqueness.
  //
  // ⛔️ Also, IDBSideSync doesn't currently support "nested" keyPath values (e.g., `keyPath: 'foo.bar'`).
  const todosStore = db.createObjectStore("todos", { keyPath: "id" });

  // Give IDBSideSync a chance to create its own object stores and indices.
  IDBSideSync.onupgradeneeded(event);
};

openRequest.onsuccess = () => {
  // Now that the object stores exist, allow IDBSideSync to initiailize itself before using it.
  IDBSideSync.init(openreq.result);
};
```

### Adding objects

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

### Updating objects

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

Only pass in an object with props/values that you have actually changed. This helps ensure that your changes, and the changes that might be made to the same object somewhere else, are _merged_.

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

### Deleting objects

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

### Syncing

As described in the "How it works" section above, the idea with syncing is to copy oplog entries from one client to some other place where those entries can be downloaded by another client that would then apply the CRDT state changes to its own IndexedDB object stores. For example, a user might log in to your app on their phone's browser, upload their oplog entries to Google Drive, and then download and "replay" those changes from Google Drive when they use your app in a browser on their laptop.

The core IDBSideSync library doesn't know how to copy the oplog entries around; it relies on one or more plugins--separate JavaScript objects that implement a standard interface--to handle things like uploading/downloading oplog entries. For an example, see the Google Drive plugin in [`plugins/googledrive/`](./plugins/googledrive).

> Interested in adding plugins to support additional remote stores? Please take a look through the "Issues" section (e.g., [Dropbox support](https://github.com/clintharris/IDBSideSync/issues/6)) or submit a pull request! While adding support for "more common" storage services (i.e., places where more users may already have an account) may be prioritized, there's also potential to develop plugins that sync with more interesting data stores, such as IPFS, [HTTP-accessible email](https://github.com/clintharris/IDBSideSync/issues/13), or even file import/export. The main limitation is that the data store be accessible via browser APIs.

Your app is responsible for registering sync plugins. Here's an example, copied from [`main.js`](app_demos/plainjs_todos/main.js) in the "ToDo" demo app:

```javascript
// Instantiate and register the Google Drive plugin
const googleDrivePlugin = new IDBSideSync.plugins.googledrive.GoogleDrivePlugin({
  googleAppClientId: '1004853515655-8qhi3kf64cllut2no4trescfq3p6jknm.apps.googleusercontent.com',
  defaultFolderName: 'IDBSideSync ToDo App',
  onSignInChange: onGoogleSignInChange,
});
await IDBSideSync.registerSyncPlugin(googleDrivePlugin);

// Sync with remote storage services using whatever plugins are registered
await IDBSideSync.sync();
```

Although a plugin doesn't have to be implemented in TypeScript, the `SyncPlugin` interface in [`main.d.ts`](types/common/main.d.ts) defines the functions that a plugin needs to implement. For example, a plugin needs to implement a `getRemoteEntriesForClient()` function, which is used as follows in the `sync()` function of the core library's [`sync.ts`](lib/src/sync.ts) file:

```javascript
let remoteEntryDownloadCounter = 0;
for await (const remoteEntry of plugin.getRemoteEntries({
  clientId: remoteClientId,
  afterTime: mostRecentKnownOplogTimeForRemoteClient,
})) {
  db.applyOplogEntry(remoteEntry);
  remoteEntryDownloadCounter++;
}
log.debug(`Downloaded ${remoteEntryDownloadCounter} oplog entries for remote client '${remoteClientId}'.`);
```

## FAQ

### Q: How is this different from Firebase?

IDBSideSync isn't trying to compete with Firebase. It's trying to demonstrate a different approach to how apps can store user's data. Instead of an app coupling itself to Firebase--a place where a user can't really access or assert control over their own data--IDBSideSync is asking the question: what if the app lets the user choose where their data is kept, and what if they can easily manage the data while it's there?

Also, Firebase might be better suited for "temporarily offline" vs. "offline first" apps, with a focus on keeping most data remote and minimizing a local cache to only what is necessary. Although not officially documented, it seems that its offline cache is not intended to be used exclusively for long periods and will become less efficient as time passes (as suggested by one of the Firebase engineers [here](https://stackoverflow.com/a/38790754/62694).

The concept that IDBSideSync is trying to prove won't work for many apps. An app that needs to handle a ton of data and support real-time collaboration among many users might need to use a DBaaS like Firebase. But there's also a category of software where things can work primarily offline without real-time sync, that might be improved by allowing users to "keep" their own data without giving up sync or using a public ledger. 

### Q: How is this different from CouchDB/PouchDB/Couchbase?

Similar to Firebase, an app that uses a "Couch" database will probably only sync with servers/peers that support that protocol/API. IDBSideSync's goal, however, is to allow users to pick and choose where their data is stored remotely and to support remote storage options that they already use and can easily manage themselves (i.e., a Google Drive folder instead of figuring out how to manage their own data on Couchbase).

### Q: I really dislike the IndexedDB API...do I have to use it?

Yes, IDBSideSync only works with IndexedDB. It's a pragmatic choice if you want a persistent data store API that is ubiquitous across most browsers.

That said, agreed: the IndexedDB's API isn't nearly as convenient as many popular databases. Take a look at Jake Archibald's [idb](https://github.com/jakearchibald/idb) library--it makes using IndexedDB a bit easier.

### Q: What types of object stores does it work with?

IDBSideSync does not support object stores that use `autoIncrement`. If IndexedDB is auto-assigning the object IDs, then it's possible for two separate clients to create an object with the same key/ID. In that scenario, there's no safe way to share and apply oplog entries (i.e., CRDT messages) since they might describe mutations that _appear_ to be relevant to the same object but actually could refer to different objects that have the same key/ID.

Also, IDBSideSync currently doesn't support `add(value, key)` or `put(value, key)` calls when `key` is of type `ArrayBuffer` or `DataView`.

### Q: What happens if the same oplog/change message is "ingested" more than once?

It will have no effect on the data store. Message values are only applied to the data store if the message's HLC time is more recent than the current value.

### Q: Why does it add `IDBSideSync_*` object stores to my app's IndexedDB database?

IDBSideSync uses these stores to record all of the change operations ("oplog" entries) and keep track of internal things like information that registered sync plugins use with remote storage services.

Also, IDBSideSync's object stores need to be "co-located" your app's stores so that both sets of stores can be included in the same transactions. If your app's attempt to write data to its own store fails, then IDBSideSync's attempt to record the operation as an oplog entry should also fail.

### Q: Is the remote syncing mechanism resilient to tampering?

Any entity that has access to the oplog entry data while stored on a remote file system has the ability to alter those CRDT messages. Granting an entity access to a data store used for remote sync implies trusting that entity. In other words, the remote store--usually something like a shared folder within Dropbox or Google Drive--should only be shared with people you trust.

That said, it would be nice to detect (and possibly fix) accidental deletion or alteration of oplog entry data. Adding data integrety checks is on the roadmap (see [issue #4](https://github.com/clintharris/IDBSideSync/issues/4)).
