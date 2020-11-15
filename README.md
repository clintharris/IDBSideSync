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
- [ ] Incorporate Jared Forsyth's HLC string formatting improvements that allow for longer timestamp and counter strings:
    - `physTime.toString().padStart(15, '0')` // 13 digits is enough for the next 100 years, so 15 is plenty
    - `count.toString(36).padStart(5, '0') // 5 digits base 36 is enough for more than 6 million "out of order" changes
    - https://jaredforsyth.com/posts/hybrid-logical-clocks/
- [ ] Add full integration test/simulation of messages from multiple nodes being processed
    - verify that event ordering is correct (i.e., that various table/row/column values end up with values specified by "most recent" corresponding operation)
    - this will require implementation of in-memory data store
    - how will this work without the use of the merkle tree for efficient diffing? is that even necessary?
    - make sure to prevent the "many changes in same ~10sec window causes issue" problem (https://twitter.com/jaredforsyth/status/1228366315569565696)
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
- [ ] Modify Timestamp.parse() to do a better job of checking for issues with the passed-in string and throwing errors if necessary (e.g., throwing if an invalid month is specified)

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

- [ ] Support _syncing_ with remote file storage services
    - Once a standard API exists for the _local_ data store (which can be implemented with different adapters), modify the sync code so that it uses a standard API, which would allow for different remote storage providers to be plugged in.
    - `oploggy-sync-gdrive`, `oploggy-sync-icloud`, etc.
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
        2. OR just iterate over the full list (without sorting) and download each file as necessary
            - if there are thousands of files, this would more efficient since it's not necessary to load the entire list into memory (similar to using a DB cursor)
        - this could be done by "searching" for files using a filename pattern that will exclude oplog entries before some time (see https://stackoverflow.com/a/11011934/62694)
        - OR (maybe simpler but much less efficient), download all file _names_ (i.e., list dir), iterate over them (parsing each filename to an actual HLC time that can be compared to the reference HLC time), and download each one that occurs on/after the reference time.

## Questions

- What happens if the same message is added to merkle tree more than once?

