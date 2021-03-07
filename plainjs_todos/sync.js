setClock(makeClock(new Timestamp(0, 0, makeClientId())));

let _onSync = null;
let _syncEnabled = true;

function setSyncingEnabled(flag) {
  _syncEnabled = flag;
}

async function post(data) {
  // let res = await fetch('https://crdt.jlongster.com/server/sync', {
  let res = await fetch('http://localhost:8006/sync', {
    method: 'POST',
    body: JSON.stringify(data),
    headers: {
      'Content-Type': 'application/json',
    },
  });
  res = await res.json();

  if (res.status !== 'ok') {
    throw new Error('API error: ' + res.reason);
  }
  return res.data;
}

/**
 * Apply the data operation contained in a message to our local data store
 * (i.e., set a new property value for a secified dataset/table/row/column).
 */
function apply(msg) {
  let table = _data[msg.dataset];
  if (!table) {
    throw new Error('Unknown dataset: ' + msg.dataset);
  }

  let row = table.find(row => row.id === msg.row);
  if (!row) {
    table.push({ id: msg.row, [msg.column]: msg.value });
  } else {
    row[msg.column] = msg.value;
  }
}

/**
 * For an incoming array of messages, build a Map where each key is an
 * _incoming_ message for a specific field (i.e., dataset + row + column) and
 * the value is the most recent _local_ message for that same field (if one
 * exists). If none exists, it will map to `undefined`.
 */
function mapIncomingToLocalMessagesForField(incomingMessages) {
  let incomingFieldMsgToLocalFieldMsgMap = new Map();

  // We are going to be searching for the _most recent_ local message for
  // specific fields, so we'll want to sort the local messages by timestamp
  // first.
  let sortedLocalMessages = [..._messages].sort((m1, m2) => {
    if (m1.timestamp < m2.timestamp) {
      return 1;
    } else if (m1.timestamp > m2.timestamp) {
      return -1;
    }
    return 0;
  });

  incomingMessages.forEach(incomingMsg => {
    // Attempt to find the SINGLE, most recent (because the array of messages is
    // sorted by timestamp), local message for the same field as the current
    // incoming message (note that find() can return `undefined` if no match is
    // found).
    let mostRecentLocalMsg = sortedLocalMessages.find(
      localMsg =>
        incomingMsg.dataset === localMsg.dataset &&
        incomingMsg.row === localMsg.row &&
        incomingMsg.column === localMsg.column
    );

    // Note that the incoming message OBJECT is being used as a key here
    // (something you couldn't do if an Object were used insteaad of a Map)
    incomingFieldMsgToLocalFieldMsgMap.set(incomingMsg, mostRecentLocalMsg);
  });

  return incomingFieldMsgToLocalFieldMsgMap;
}

function applyMessages(incomingMessages) {
  let incomingToLocalMsgsForField = mapIncomingToLocalMessagesForField(
    incomingMessages
  );
  let clock = getClock();

  // Look at each incoming message. If it's new to us (i.e., we don't have it in
  // our local store), or is newer than the message we have for the same field
  // (i.e., dataset + row + column), then apply it to our local data store and
  // insert it into our local collection of messages and merkle tree (which is
  // basically a specialized index of those messages).
  incomingMessages.forEach(incomingMsgForField => {
    // `incomingToLocalMsgsForField` is a Map instance, which means objects
    // can be used as keys. If this is the first time we've encountered the
    // message, then we won't have a _local_ version in the Map and `.get()`
    // will return `undefined`.
    let mostRecentLocalMsgForField = incomingToLocalMsgsForField.get(
      incomingMsgForField
    );

    // If there is no corresponding local message (i.e., this is a "new" /
    // unknown incoming message), OR the incoming message is "newer" than the
    // one we have, apply the incoming message to our local data store.
    //
    // Note that although `.timestamp` references an object (i.e., an instance
    // of Timestamp), the JS engine is going to implicitly call the instance's
    // `.valueOf()` method when doing these comparisons. The Timestamp class has
    // a custom implementation of valueOf() that retuns a string. So, in effect,
    // comparing timestamps below is comparing the toString() value of the
    // Timestamp objects.
    if (
      !mostRecentLocalMsgForField ||
      mostRecentLocalMsgForField.timestamp < incomingMsgForField.timestamp
    ) {
      // `apply()` means that we're going to actually update our local data
      // store with the operation contained in the message.
      apply(incomingMsgForField);
    }

    // If this is a new message that we don't have locally (i.e., we didn't find
    // a corresponding local message for the same dataset/row/column OR we did
    // but it has a different timestamp than ours), we need to add it to our
    // array of local messages and update the merkle tree.
    if (
      !mostRecentLocalMsgForField ||
      mostRecentLocalMsgForField.timestamp !== incomingMsgForField.timestamp
    ) {
      clock.merkle = merkle.insert(
        clock.merkle,
        Timestamp.parse(incomingMsgForField.timestamp)
      );

      // Add the message to our collection...
      _messages.push(incomingMsgForField);
    }
  });

  _onSync && _onSync();
}

function sendMessages(messages) {
  applyMessages(messages);
  sync(messages);
}

function receiveMessages(messages) {
  messages.forEach(msg =>
    Timestamp.recv(getClock(), Timestamp.parse(msg.timestamp))
  );

  applyMessages(messages);
}

function onSync(func) {
  _onSync = func;
}

async function sync(initialMessages = [], since = null) {
  if (!_syncEnabled) {
    return;
  }

  let messages = initialMessages;

  if (since) {
    let timestamp = new Timestamp(since, 0, '0').toString();
    messages = _messages.filter(msg => msg.timestamp >= timestamp);
  }

  let result;
  try {
    result = await post({
      group_id: 'my-group',
      client_id: getClock().timestamp.node(),
      messages,

      // Post our entire merkle tree. At a high level, this is a data structure
      // that makes it easy to see which messages we (the client) know about
      // for given timestamps. The other node (server) will use this to quickly
      // figure out which messages it has that we do not have.
      merkle: getClock().merkle,
    });
  } catch (e) {
    throw new Error('network-failure');
  }

  if (result.messages.length > 0) {
    receiveMessages(result.messages);
  }

  let diffTime = merkle.diff(result.merkle, getClock().merkle);

  if (diffTime) {
    if (since && since === diffTime) {
      throw new Error(
        'A bug happened while syncing and the client ' +
          'was unable to get in sync with the server. ' +
          "This is an internal error that shouldn't happen"
      );
    }

    return sync([], diffTime);
  }
}
