`oploggy-core` is a JavaScript library that manages the creation, indexing, and syncing of CRDT _messages_ across peers.
Each peer can apply these messages to a local data store, in effect, creating a _distributed_ data store that is kept in
sync without conflict--a CRDT. `simple-crdt` allows you to choose/implement whatever mechanism you want to use for the
actual underlying storage (e.g., in-memory objects, SQLite, IndexedDB, etc.).

`oploggy-core` was forked from [James Long](https://twitter.com/jlongster)'s
[crdt-example-app](https://github.com/jlongster/crdt-example-app); most of the code should be considered a re-organized
and (in some cases) modified version of his work.

# Roadmap

- [ ] Convert files to TypeScript
- [ ] Add unit tests (to ensure consistent behavior in next step, refactoring)
- [ ] Set up [TSDX](https://tsdx.io/) to make it easier to publish libraries?
- [ ] Refactor code (rename functions, classes, restructure code to classes, etc.)
    - Easier/safer to do this after everything is using TypeScript
    - Safer to do this after unit tests exist
- [ ] Move to oploggy monorepo with `core` subdir (future: `store-indexeddb`, etc., subdirs/packages).
- [ ] Add support for new features

## Refactoring

- [ ] `Clock`: Create a Clock class, make `_clock` and the non-class-based functions "var static" members.
- [ ] Rename Timestamp to `HybridLogicalTimestamp` (or `HybridLogicalTime`)
- [ ] Rename Clock to HybridLogicalClock
- [ ] Move Timestamp.send() into `Clock` and rename/refactor it to work as `Clock.next()`. This makes sense because:
    - Timestamp.send() is only being used to increment the local clock singleton anyways (i.e., it's only ever called as `Timestamp.send(getClock())`); `Clock.next()` makes it more obvious that the local clock is being updated/advanced to the next hybrid logical time.
- [ ] Consider increasing the allowed difference for clock times coming from other systems; only allowing for a 1-minute difference between any other clock in the distributed system seems like it could be error prone...

## New features

- [ ] Support custom _local_ data store APIs (i.e., support offline, PWA-friendly storage)
    - Currently the "data store" is just a few arrays kept in memory (`_messages` and  `_data`)
    - It should be possible to use other, more efficient data storage mechanisms (e.g., IndexedDB).
    - Instead of accessing `_messages` and `_data` directly as arrays, the data store should be passed-in and manipulated through standard API functions for CRUD operations; the actual implementation for those operations should be a black-box.
    - Example:
        - `sync.js:mapIncomingToLocalMessagesForField()` needs to find the "most recent" message for specific fields. Currently it does this by sorting the big array of `_messages` and searching for the first element with a matching set of field identifier criteria, which clearly becomes less efficient as the array of `_messages` grows over time.
        - Ideally, the data store API would have a `findMostRecentMessageForField()` method that, under the hood, would use pre-built indices for searching messages.
    - `oploggy-store-indexeddb`
    - `oploggy-store-inmemory`

- [ ] Support _syncing_ with remote data stores
    - Once a standard API exists for the _local_ data store (which can be implemented with different adapters), modify the sync code so that it user a standard API, which would allow for different remote storage providers to be plugged in.
    - `oploggy-sync-gdrive`, `oploggy-icloud-sync`