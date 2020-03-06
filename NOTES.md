# Notes

The purpose of this doc is to supplement the code in the `crdt-example-app` with notes that help describe how things work. While the example app uses a todo list as a use case, the real focus is on demonstrating the underlying distributed database and CRDT concepts; that is also the focus of these notes.

## How it Works: Summary

In a nutshell, the UI sits on top of a distributed database that is kept in sync using CRDT techniques:
  - CRUD operations do not modify an underlying data store _directly_ as would be the case with a typical database.
  - Instead, when a change is made to a specific field, a message is created that logs _which_ field was changed, _what_ the new value is for that field, and _when_ the change happened,.
    - The "when" is a hybrid logical clock timestamp.
  - Each agent maintains its own collection of these messages; in effect, they create an "operation journal / log".
    - An accompanying data structure, a merkle tree, is also maintained that makes it possible to _quickly_ compare different message collections and figure out (roughly) which messages need to be exchanged to sync the collections.
    - The merkle tree only stores what it needs to answer the question "what is the last time at which the collections had the same messages?": time (as keys) and hashes (as values) made from all known messages at those times.
  - These messages are shared among agents, including a server agent that just acts as a centralized "message buffer" for syncing agents that can't connect directly.
  - When an agent (A₁) syncs with another agent (A₂):
    - A₁ sends its own merkle tree (JSON) to A₂ (which could be a server).
    - A₂ can compare the incoming merkle tree to its own tree to quickly establish a rough time at which the trees started to differ (T₁). - A₂ can then send all of its messages that have a timestamps >= T₁.
    - A₁ receives these messages from A₂ and applies them to its local database.
      - Note that it's possible that it will apply some messages that it already has--that's ok. The main goal of the merkle tree approach is to _quickly_ figure out which messages need to be exchanged based if they were created after some time, not the _exact_ messages that need to be exchanged (which could result in an expensive process of lookig up _a lot_ of individual messages by some identifier before exchanging them).
    - If, in the set of incoming messages, there is more than one message targeting the same field, only the most recent one (as determined from the message's timestamp) is used to update the field value.
      - Each message timestamp is based on a hybrid logical clock.
        - This combines a "physical" time (i.e., a normal-looking date/time) and a counter that can never go backwards (a.k.a., a "monotonic" clock)
        - HLC timestamps make it possible to determine the _order_ of events amongst a group of agents whose physical clocks might not be in sync (i.e., the goal is to establish causality--A happened before B--NOT the actual time things happened).


### Slightly more detailed workflow

1. When UI widgest are used to create/edit/delete todos, the following `db.*` functions are called with data params. Example:

    ```javascript
    db.insert('todos', { name, type, order: getNumTodos() });
    db.update('todos', { id: uiState.editingTodo.id, name: value });
    db.delete_('todos', e.target.dataset.id);
    ```

1. The `db.*` method creates one or more messages from the object that is passed in and then "sends" them:

    ```javascript
    // db.js
    function update(table, params) {
      let fields = Object.keys(params).filter(k => k !== 'id');
      sync.sendMessages(
        fields.map(k => {
          return {
            dataset: table,
            row: params.id,
            column: k,
            value: params[k],
            // Note that every message we create/send gets its own, globally-
            // unique timestamp. In effect, there is a 1-1 relationship between
            // the timestamp and this specific message.
            timestamp: Timestamp.send(getClock()).toString()
          };
        })
      );
    }
    ```

1. `sync.sendMessages()` applies the message to the local data store first, then attempts to initiate a sync.

    ```javascript
    // sync.js
    function sendMessages(messages) {
      applyMessages(messages);
      sync(messages);
    }
    ```

1. `sync.applyMessages()` looks at each incoming message (which will be aimed at changing data for a specific dataset + row + field) and does the following:
  - Do we have any local messages for the same field?
    - If so, is the incoming message for that field newer than ours?
      - If so, `apply()` the incoming message's value for the specified dataset/row/field to our own datastore.
  - Do we already have a copy of this message in our local store of messages and merkle tree?
    - If not, add it.





## Concepts

### Clocks

The main goal with clocks as they pertain to distributed databases is to be able to _order_ events. In other words, knowing which event was the _last_ to happen is more of a concern than knowing exactly _when_ they happened, because in this context, the question being asked is: what is the _most recent_ message that set a value for a field?

#### Logical clocks and the Lamport timestamp/clock

A logical clock is a mechanism that makes it possible to determine "one-way causality": if "A happened before B". It cannot, however, determine if "B happened after A". (Note that two-way causality is supported by a logical clock variant called a "vector clock.")

Commonly used in distributed systems where actual clocks may not be in sync
  - Main goal is to be able to determine the "causal relationship" between events (i.e., A happened before B), NOT the actual time things happened.

The _Lamport clock_ was the first implementation of a logical clock. It is basically just a counter that is shared among all nodes/processes in a distributed system. The counter gets incremented every time:

  1. A process event occurs (e.g., some data is updated)
  2. A process receives message with counter from another process.
     - i.e., when nodes exchanges messages, the receiver re-synchronizes its logical clock with that sender

In other words, every node/process maintains its own counter/timestamp and _always_ ensures that it re-synchronizes with the counter when messages are received from other nodes. Specifically, it'll make sure to reset its _own_ counter to whichever counter is _greater_--possibly the one from another node--and then increment.

A _Lamport timestamp_ is just a "monotonically" increasing (i.e., never decreasing) counter.

##### Sending algorithm

```javascript
// Sending is an event. Any time an event happens, ensure time moves forward (i.e., increment the timestamp/counter)
time = time + 1

// Send the message with the incremented timestamp
send(message, time)
```

##### Receiving algorithm

```javascript
// Receiving is an event. Any time an event happens, ensure time moves forward
function receive(message, time_stamp) {
  // We'll always increment time, but if the sender's timestamp is greater than ours, use that as the new basis. This is
  // how we ensure that the counter is moving forward throughout the distributed system.
  time = max(time_stamp, time) + 1;
}
```

#### Hybrid Logical Clock

An HLC combines both a _physical_ and _logical_ clock. It was designed to provide one-way (as with LC rather than VC) causality detection while maintaining a clock value close to the physical clock, so one can use HLC timestamp as a drop-in replacement for a physical clock timestamp. Rules:

  1. Each node maintain its own monotonic counter, `c` (just like with logical clocks)
  1. Each node keeps track of the largest physical time it has encountered so far
    - this is called the "logical" time (`l`)
  1. When a message is received:
    - The receiving node updates its own logical lock to ensure that it moves forward by picking whichever of the following is greater:
       a. the current physical time (e.g., `Date.now()`), or
       b. the logical time stored in the message
    - If the logical times are all equal, increment the counter (`c`)

In other words, if the physical clocks on all nodes are in perfect sync, then the counter is the only thing that gets incremented each time a message is received. However, it's more common that a node is always going to reset its logical time and counter each time a message is received.

### Resources

  - Extremely helpful: http://sergeiturukin.com/2017/06/26/hybrid-logical-clocks.html\
  - MongoDB 3.6 (released ~2017) uses HLC's and "oplogs" (i.e., a log of operations, much like messages in this app): https://www.mongodb.com/blog/post/transactions-background-part-4-the-global-logical-clock
  - https://www.youtube.com/watch?v=CMBjvCzDVkY





## How it Works in Detail


## `index.html`

  - Creates <div id="root">
  - loads the following:
    - `murmurhash.js`: a library for generating hashes _quickly_ (not crypto-grade).
    - `uuidv4`: library for genearting v4 UUIDs
    - `shared/timestamp.js`: 
    - `shared/merkle.js`
    - `clock.js`
    - `sync.js`
    - `db.js`
    - `main.js`


## main.js

  - Creates a `uiState` variable:
    - offline: false,
    - editingTodo: null,
    - isAddingType: false,
    - isDeletingType: false

  - Creates a "clock" (a timestamp, really, but we called a "clock" because it will periodically be updated when events occur)
    - This is just an object with two props: a `MutableTimestamp` and a merkle tree
    - When we talk about the clock, we're really talking about the `MutableTimestamp` in this object
    - It's more like a counter... It gets "incremented" every time a message is sent or received

  - `render()`
    - Uses `append()` to insert HTML into <div id="root">
    - Renders todos and deleted todos
      - `db.js:getTodos()` and `db.js:getDeletedTodos()` return todos from in-memory array
    - if `uiState.editingTodo`, renders HTML for editing todo
    - if `uiState.isAddingType`, renders HTML for adding new todo
    - if `uiState.isDeletingType`, renders HTML for adding new todo
    - Sets up event listeners
      - `#add-form` submit
      - `#btn-sync` click`
      - `#btn-offline-simulate` click
      - etc.

  - Registers `onSync()` callback
    - Every time `sync.js:applyMessages()` finishes, it will trigger callback
    - callback just re-renders all the HTML

  - Calls `sync.js:sync()` to start the first sync, then
    - If there aren't any todo types after the sync, it creates some default ones via `db.js:insertTodoType()`

  - Sets up timer to call `sync()` every 4 seconds
    - 👉 _Note that this initializes the clock_: `setClock(makeClock(new Timestamp(0, 0, makeClientId())));`
      - `makeClientId()` is just part of a UUID (specifically, the last 16 chars).
        - UUID: `37c2877f-fbf4-40f3-bdb7-87f4536dc989` 
        - client ID: `bdb7-87f4536dc989` (without the hyphen)


## clock.js

The "clock" is really a private variable (an object) that has two components:

  - a mutable timestamp
  - a merkle tree

This file exposes functions for getting/setting the singleton app clock, as well as creating one, and serializing/deserializing clocks (i.e., to/from JSON).


## timestamp.js

Defines `Timestamp` and `MutableTimestamp` classes. Comprised of `millis`, `counter`, and `node`. 

The stringified timestamps are FIXED LENGTH in the format `<date/time>-<counter>-<client ID>`, where:

  - `<date/time>` is ISO 8601 date string via `Date.toISOString()`
  - `<counter>` is a hexadecimal encoded version of the counter, always 4 chars in length
    - ensuring that we never have more that 4 chars means there is a limit to how big the counter can be: 65535.
    - (65533).toString(16) -> fffd (4 chars)
    - (65534).toString(16) -> fffe
    - (65535).toString(16) -> ffff
    - (65536).toString(16) -> 10000 -- oops, this is 5 chars
  - `<client ID>` is the last 16 chars of a UUID (with hyphen removed):
      - UUID: `xxxxxxxx-xxxx-xxxx-bdb7-87f4536dc989`, client/node: `bdb787f4536dc989`

  - `millis`: milliseconds
    - the Timestamp used to init the clock at startup has this set to `0`
    - `Timestamp.parse()` sets this to elapsed msecs since 1/1/70 (e.g., when receiving a message)
  - `counter`
    - the Timestamp used to init the clock at startup has this set to `0`
  - `node`
    - identifies the client, or node, that created the timestamp


Examples:

  - `2020-02-02T16:29:22.946Z-0000-97bf28e64e4128b0` (millis = 1580660962946, counter = 0, node = 97bf28e64e4128b0)
  - `2020-02-02T16:30:12.281Z-0001-bc5fd821dc0e3653` (millis = 1580661012281, counter = 1, node = bc5fd821dc0e3653)
    - Note that `<ISO 8601 date string>` is via `Date.toISOString()`


### Important functions

Timestamp.send(clock)
  - This function is used to create a new timestamp every time a message is sent (i.e., every time a database CRUD operation causes a new message to be created/sent)
  - Creates/returns a new `Timestamp` using the `clock` arg.


## db.js

This file exposes functions that resemble a database API. It sets up a couple of global variables that are in-memory data stores for messages and todo objects, and creates global functions for CRUD operations on those stores. In a more realistic app, one might use something like IndexedDB or SQLite as the underlying storage mechanism.

Each data store is comparable to a database table:
  - `todo`: an array of `{ name: string, type: string, order: number }` objects
  - `todoTypes`: an array of `{ name: string, color: string }` objects
  - `todoTypeMappings`: an array of `{ id: <typeId>, targetId: <typeId>} }` objects

GET functions all return objects from the various in-memory arrays:
  - `getTodos()` returns `_data.todos` (filters `.tombstone !== true`)
  - `getDeletedTodos()` returns `_data.todos` (filters `.tombstone === true`)
  - `getTodoTypes()` returns `_data.todoTypes` (filters `.tombstone !== true`)
  - etc.

INSERT/UPDATE functions don't modify the in-memory stores; instead, they create and send a message for each property/value pair of the object being inserted/updated/deleted. 

```javascript

// For example, inserting the following to-do object:
{
  "name": "Make dinner",
  // This is an ID that points to the 'Personal todo' type
  "type": "570694fc-6e30-496a-8a37-95ab5bec0311",
  "order": 5
}

// Results in code like this running in db.insert():
id = uuidv4(); // Comparable to creating our own primary key if it were an RDBMS,
sendMessages([{
  dataset: 'todos',
  row: id
  column: 'name',
  value: 'Make dinner',
  // Note that every message we create/send gets its own, globally-unique
  // timestamp. In effect, there is a 1-1 relationship between the time-
  // stamp and this specific message.
  timestamp: Timestamp.send(getClock()).toString()
},{
  dataset: 'todos',
  type: '570694fc-6e30-496a-8a37-95ab5bec0311', 
  row: id,
  column: 'type',
  value: '570694fc-6e30-496a-8a37-95ab5bec0311',
  timestamp: Timestamp.send(getClock()).toString()
}, ...])

// Which results in JSON messages like this:
[
  {
    "dataset": "todos",
    "row": "5a9c7c59-3a73-455c-8c5b-49a03a09c852",
    "column": "name",
    "value": "Make dinner",
    "timestamp": "2020-02-09T20:28:21.212Z-0000-87854eaf99288a48"
  },
  {
    "dataset": "todos",
    "row": "5a9c7c59-3a73-455c-8c5b-49a03a09c852",
    "column": "type",
    "value": "570694fc-6e30-496a-8a37-95ab5bec0311",
    "timestamp": "2020-02-09T20:28:21.212Z-0001-87854eaf99288a48"
  },
  {
    "dataset": "todos",
    "row": "5a9c7c59-3a73-455c-8c5b-49a03a09c852",
    "column": "order",
    "value": 4,
    "timestamp": "2020-02-09T20:28:21.212Z-0002-87854eaf99288a48"
  }
]
```

In other words, when inserting a new object:
  - the object gets a unique ID (UUID).
    - This is comparable to an auto-incremented ROWID in a database table.
  - A message is sent for setting each key/value pair in the object
    - This is comparable to issuing a SET statement for each column in the table
  - Each message gets a unique timestamp (i.e., unique because it is an HLC
    timestamp that includes the current node's UUID).
    - In effect, the timestamp is a unique identifier for the message.

DELETING means setting the `tombstone` column to true:

```javascript
// Delete the "Groceries" type
sendMessages([{
  dataset: 'todoTypes', row: id, column: 'tombstone', value: 1, timestamp: Timestamp.send(getClock()).toString()
}])
```

### The timestamp

Every message includes a timestamp generated via `Timestamp.send(getClock()).toString()`.

  - `Timestamp.send()`: generates a unique, "monotonic" timestamp as a string
    - `getClock()`



## sync.js

> TODO

## merkle.js

This file contains functions used to perform operations on a merkle tree. A merkle tree is really just a bunch of nodes with hashes, where each node's hash is made from the hashes of its children. This makes merkle trees a great data structure for quickly comparing collections to see if they have the same items.

In this case, the application uses a merkle tree to quickly figure out if two clients have the same collection of data operation messages (e.g., a message saying a specific table -> row -> column should be set to some value).

Taking a step back, consider that a _really_ simple way to tell if two clients have the same messages would be: each client maintains a "rolling" hash of their messages. Each time a new message is added to the log, the rolling hash would be re-calculated by combining it with a hash of the new message. To tell if the clients have the same messages, you'd just compare their rolling hash values.

However, this only tells you if the clients have encountered the same messages (i.e., if their rolling hashes were derived from the same set of message hashes); _it doesn't help you figure out how the collections differ_. That's why this app uses a merkle tree is used instead of a single rolling hash value.

More specifically, the merkle tree used by this app indexes rolling hashes of "known messages" by the _times_ for those messages. _This means you can quickly compare two merkle trees, and if they differ, find the most recent "message time" when they were the same_.

Knowing that the difference(s) exist at some point _after_ that time (i.e., one client has messages after that time which the other client lacks), a more efficient sync can be done by exchanging _only_ the messages that occurred after that time.

> Note: the merkle tree doesn't store hashes that are literally made from the messages--they are actually derived from each message's _timestamp_ (`Timestamp.hash()`). But since each message's timestamp is unique (they incorporate time, a counter, and a UUID), _the timestamp becomes a unique identifier for the message_. So it's probably okay--and maybe easier for some people--to just think of them as being "message 

### The values being stored: message hashes

In this application, the items are essentially message "identifiers" (i.e., a message's `Timestamp.hash()` value) and the merkle tree is used to quickly tell what messages a client needs to be in sync with another client. In other words, when Client A attempts to sync with another client, we want to minimize the number of messages sent so we need a quick way to figure out how the collections differ.

Each client maintains its own merkle tree; every time a field in the data store is changed, the client creates a new message with a corresponding, unique timestamp (i.e., it basically identifies the message), and that timestamp's _hash_ is inserted into merkle tree. A "key" (the timestamp's physical time--minutes since 1970) is used as a path to navigate down the tree and insert a new "leaf node" with the hash. That new node might be inserted several levels down in the tree; the hash for each node along that "path" (starting at the root) will be recalculated as a hash of the current value and the new node's hash.

In effect, each node maintains a "rolling hash" that is derived from all its children as they are inserted. This includes the root node, which means: the root hash for two merkle trees will be the same only if the same set of messages have been inserted into both trees.

_This means that you can tell if two clients have the same messages just by comparing the root hash._

This algorithm depends on the hashing being commutative: `hash(C, hash(A, B)) === hash(A, hash(B, C))`. So the order in which messages identifiers are inserted doesn't matter--merkle trees on two different clients will have the same root hash as long as the same items have been inserted.

### The keys

As previously stated, the keys for the merkle tree are the times for each message in "minutes since 1970." The minutes are base-3 encoded, so numbers only consist of digits 0, 1, or 2 (also, note that the base-3 encoded minutes are converted to STRINGS). This means that you end up with keys like "1211121022121121".

Each character in the string is used to access the next child node. In other words, each node in this application's merkle tree is an object with 1-4 things:

  1. A `hash` property. This is a hash of the Timestamp (as calculated by `Timestamp.hash()`).
  2. (maybe) a `"0"` property referencing a child node
  3. (maybe) a `"1"` property referencing a child node
  4. (maybe) a `"2"` property referencing a child node

This means that each node can have, at most, 3 children. In other words, this is a _ternary tree_ structure (vs. a binary tree, for example).

If you visualize each node's children as being sorted from left-to-right, this means a tree that might look something like this:

```
                                     Root
            ┌─────────────────────────┼─────────────────────────┐
            0                         1                         2
   ┌────────┼───────┐        ┌────────┼───────┐        ┌────────┼───────┐
   0        1       2        0        1       2        0        1       2
┌──┼──┐  ┌──┼──┐ ┌──┼──┐  ┌──┼──┐  ┌──┼──┐ ┌──┼──┐  ┌──┼──┐  ┌──┼──┐ ┌──┼──┐
0  1  2  0  1  2 0  1  2  0  1  2  0  1  2 0  1  2  0  1  2  0  1  2 0  1  2
```

For an over-simplified example, a "time" (in base-3) like 120 becomes "120". So first you'd use '1' to get a node, then '2' to get a node, then '0' to get the last node.

> Node that that the minutes could use any base (e.g., it could be in hex) as long as the individual characters in the stringified version of a key can be sorted (which is a key part of the `merkle.js:diff()` function). 

To state the obvious: as time elapses, this value increases--which is important to note because this is why it's possible to "walk" the nodes of the tree from "further back in time" to "more recent in time." And being able to navigate the tree chronologically like that is necessary if you want to efficiently find the most recent message time when two trees were equal.

If time starts at t₀ (000), then the path to the first time is the branch furthest to the right. As the integer for time increases, you're basically moving from left to right. Use the diagram above to walk through each of the paths for the following sequence of time (which is basically counting up in base-3):

  - t₀ = 000
  - t₁ = 001
  - t₃ = 010
  - t₂ = 002
  - t₄ = 011
  - t₅ = 012
  - t₆ = 020

### Inserting new items into the merkle tree

The `merkle.js:insertKey()` function implements the "insert" operation. Here's and example that shows how it works (where `h(...)` is shorthand for "hash of ..."):

1. Two clients #1 and #2 both record a message timestamp: { time: '000', hash: A }

```
 root: h(A)
 │
 0: h(A)
 │
 0: h(A)
 │
 0: h(A)
```

2. Both clients record a message timestamp: { time: '101', hash: B }

```
        root: h(A,B)
        │
        0: h(A,B)
 ┌──────┴─────┐
 0: h(A)      1: h(B)
 │            │
 0: h(A)      0: h(B)
```


3. Both clients record a message timestamp: { time: '011', hash: C }

```
         root: h(A,B,C)
         │
         0: h(A,B,C)
 ┌───────┴───────┐
 0: h(A)         1: h(B,C)
 │         ┌─────┴─────┐
 0: h(A)   0: h(B)     1: h(C)
```

4. New messages:
  - Client #1 records message timestamp: { time: '012', hash: 🍏 }.
  - Client #2 records message timestamp: { time: '020', hash: 🍊 }
  - Both clients record message timestamp: { time: '100', hash: 🍓 }

Now they have different merkle trees:

```
                Client #1                               Client #2
               root:h(A,B,C,🍏,🍓)                 root:h(A,B,C,🍊,🍓)
        ┌─────────┴────────────┐                 ┌──────────┴────────────┐
        0:h(A,B,C,🍏)          1:h(🍓)          0:h(A,B,C,🍊)           1:h(🍓)
┌───────┴──────┐               │         ┌───────┴──────┐                │
0:h(A)         1:h(B,C,🍏)     0:h(🍓)  0:h(A)         1:h(B,C,🍊)      0:h(🍓)
│       ┌──────┼──────┐        │         │       ┌──────┼──────┐         │
0:h(A)  0:h(B) 1:h(C) 2:h(🍏)  0:h(🍓)  0:h(A)  0:h(B) 1:h(C)  2:h(🍊)  0:h(🍓)
```


### Diffing merkle trees

The `merkle.js:diff()` function implements an algorithm for finding the last known "time of equality" and works like this:

1. Compare the top-level hashes. A^B^C^🍏^🍓 !== A^B^C^🍊^🍓 so we immediately know the trees are different.
2. Get get all the keys from the nodes in both trees, at the 1st level: ['0', '1']
3. Sort the keys alphabetically, then for each key (k), find the first key where `node1[k].hash !== node2[k].hash`
4. In this case, `k === '0'` because A^B^C^🍏 !== A^B^C^🍊; set `key = '0'`
5. Repeat the process. Get all the keys for `node1['0']` and `node2['0']`: ['0', '1']]
6. Iterate over the sorted keys (0, 1) until you find a pair of nodes with different hashes.
7. In this case, `k === '1'` because B^C^🍏 !== B^C^🍊; set `key += '1'` (i.e., key is now '01')
8. Repeat the process. Get all the keys for `node1['1']` and `node2['1']`: ['0', '1', '2']]
9. Iterate over the sorted keys (0, 1) until you find a pair of nodes with different hashes.
10. In this case, `k === '2'` because 🍏 !== 🍊; set `key += '2'` (i.e., key is now '012')
11. Repeat the process. . Get all the keys for `node1['2']` and `node2['2']`.
12. Neither of the nodes have children, so they are equal: exit.
13. We now have a `key` that is a base-3 encoded integer `012` (minutes since 1970).

To sync, Client #1 can ask for all of Client #2's messages with timestamps >= `012`: this means the 🍊 and 🍓 messages.

Client #1 already knows about the 🍓 message, so this shows that the mechanism isn't going to result in _only_ unknown messages being sync'ed; there will be dupes. But the trade-off for complete efficiency is speed. 


### Pruning

> TODO

## Reference

### UUID

 - A unique, 128-bit number
 - In string form, represented as 36 chars: 32 hex digits (i.e., 0-f) + 4 hyphen separators
    - Format: {8 chars}-{4 chars}-{4 chars}-{4 chars}-{12 chars}
    - Example: `123e4567-e89b-12d3-a456-426655440000`

### Timestamp class

> TODO