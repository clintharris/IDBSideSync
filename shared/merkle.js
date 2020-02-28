(function(root, factory) {
  if (typeof exports === 'object') {
    module.exports = factory();
  } else {
    root.merkle = factory();
  }
})(this, function() {
  function getKeys(trie) {
    return Object.keys(trie).filter(x => x !== 'hash');
  }

  function keyToTimestamp(key) {
    // 16 is the length of the base 3 value of the current time in
    // minutes. Ensure it's padded to create the full value
    let fullkey = key + '0'.repeat(16 - key.length);

    // Parse the base 3 representation back into base 10 "msecs since 1970" that
    // can be easily passed to Date()
    return parseInt(fullkey, 3) * 1000 * 60;
  }

  function insert(trie, timestamp) {
    let hash = timestamp.hash();

    // Convert the timestamp's logical time (i.e., its "milliseconds since
    // 1970") to minutes, then convert that to a base-3 STRING. Base 3 meaning:
    // 0 => '0', 1 => '1', 2 => '2', 3 => '10', 2938 => '11000211'.
    //
    // This string will be used as a path to navigate the merkle tree: each
    // character is a step in the path used to navigate to the next node in the
    // trie. In other words, the logical time becomes the "key" that can be used
    // to get/set a value (the timestamp's hash) in the merkle tree.
    //
    // Since we're using base-3, each char in in the path will either be '0',
    // '1', or '2'. This means that the trie will consist of nodes that have, at
    // most, 3 child nodes.
    //
    // Note the use of the bitwise OR operator (`... | 0`). This is a quick way
    // of converting the floating-point value to an integer (in a nutshell: the
    // bitwise operators only work on 32-bit integers, so it causes the 64-bit
    // float to be converted to an integer).) For example, this causes:
    // "1211121022121110.11221000121012222" to become "1211121022121110".
    let key = Number((timestamp.millis() / 1000 / 60) | 0).toString(3);

    // Create a new object that has the same tree and a NEW root hash. Note that
    // "bitwise hashing" is being used here to make a new hash. Bitwise XOR
    // treats both operands as a sequence of 32 bits. It returns a new sequence
    // of 32 bits where each bit is the result of combining the corresponding
    // pair of bits (i.e., bits in the same position) from the operands. It
    // returns a 1 in each bit position for which the corresponding bits of
    // either but not both operands are 1s.
    trie = Object.assign({}, trie, { hash: trie.hash ^ hash });

    return insertKey(trie, key, hash);
  }

  /**
   * The overall goal of this function is to insert a given timestamp's hash
   * into a merkle tree, where the key/path is based on a base-3 encoding of
   * the timestamp's physical time (minutes since 1970).
   * 
   * In other words, we are building a data structure where time can be used to
   * retrieve a timestamp's hash--or the hash of all timestamps that occurred
   * relative to that timestamp.
   * 
   * For example, a (oversimplified) base-3 key "012" would result in this:
   * 
   * {
   *   "hash": 1704467157,
   *   "0": {
   *     "hash": 1704467157,
   *     "1": {
   *       "hash": 1704467157,
   *       "0": { ... }
   *       "1": { ... }
   *       "2": { ... }
   *     }
   *   }
   * }
   * 
   * @param {*} currentTrie 
   * @param {*} key 
   * @param {*} timestampHash
   * @returns an object like:
   * { hash: string; '0': object; '1': object; '2': object }
   */
  function insertKey(currentTrie, key, timestampHash) {
    if (key.length === 0) {
      return currentTrie;
    }

    // Only grab the first char from the base-3 number (e.g., "20" -> "2")
    const childKey = key[0];

    // Get ref to existing child node (or create a new one)
    const currChild = currentTrie[childKey] || {};

    // Create/rebuild the child node with a (possibly) new hash that
    // incorporates the passed-in hash, and new new/rebuilt children (via a
    // recursive call to `insertKey()`). In other words, since `key.length > 0`
    // we have more "branches" of the trie hierarchy to extend before we reach a
    // leaf node and can begin returning.
    //
    // The first time the child node is built, it will have hash A. If another
    // timestamp hash (B) is inserted, and this node is a "step" in the
    // insertion path (i.e., it is the target node or a parent of the target
    // node), then the has will be updated to be hash(A, B).
    const newChild = Object.assign(
      {},
      currChild,
      // Note that we're using key.slice(1) to make sure that, for the next
      // recursive call, we are moving on to the next "step" in the "path"
      // (i.e., the next character in the key string). If `key.slice() === ''`
      // then `insertKey()` will return `currChild`--in which case all we are
      // doing here is setting the `hash` property.
      insertKey(currChild, key.slice(1), timestampHash),
      // Update the current node's hash. If we don't have a hash (i.e., we just
      // created `currChild` and it is an empty object) then this will just be
      // the value of the passed-in hash from our "parent" node. In effect, an
      // "only child" node will have the same hash as its parent; only when a
      // a 2nd (or later) 
      { hash: currChild.hash ^ timestampHash }
    );

    // Create a new sub-tree object, copying in the existing true, but... 
    return Object.assign(
      {},
      currentTrie,
      // ...set a new node value for the current key path char (e.g., { 0: ..., 
      // 1: ..., 2: ... }).
      { [childKey]: newChild }
    );
  }

  function build(timestamps) {
    let trie = {};
    for (let timestamp of timestamps) {
      insert(trie, timestamp);
    }
    return trie;
  }

  /**
   * 
   * @param {*} trie1 
   * @returns 
   * @param {*} trie2 
   */
  function diff(trie1, trie2) {
    if (trie1.hash === trie2.hash) {
      return null;
    }

    let node1 = trie1;
    let node2 = trie2;
    let k = '';

    while (1) {

      // At this point we have two node objects. Each of those objects will have
      // some properties like '0', '1', '2', or 'hash'. The numeric props (note
      // that they are strings) are what we care about--they are the keys we can
      // use to access child nodes, and we will use them to compare the two
      // nodes.
      //
      // `getKeys()` will return the prop names, filtering out `hash`. In effect
      // we are creating a set that has keys that exist on either of the nodes
      // (so the set will contain, at most: '0', '1', and '2').
      let keyset = new Set([...getKeys(node1), ...getKeys(node2)]);
      let keys = [...keyset.values()]; // Convert to arrays like ['0', '2']

      // Before we start to compare the two nodes, we want to sort the keys.
      // This has a 
      keys.sort();

      // Compare the hash for each of the child nodes. Find the _first_ key for
      // which the child nodes have different hashes.
      let diffkey = keys.find(key => {
        let childNode1 = node1[key] || {};
        let childNode2 = node2[key] || {};
        return childNode1.hash !== childNode2.hash;
      });

      // If we didn't find anything, it means the child nodes have the same
      // hashes--so we have found a point in time when the two tries equal.
      if (!diffkey) {
        return keyToTimestamp(k);
      }

      // If we got this far, it means we found a location where the two tries
      // differ (i.e., each trie has a child node at this position, but they
      // have different hashes--meaning they are the result of different
      // messages). We want to continue down this path and keep comparing nodes
      // until we can find a position where the hashes equal.
      //
      // Note that as we continue to recurse the trie, we are appending the
      // keys. This string of digits will be parsed back intoa time eventually,
      // so as we keep appending characters we are basically building a more and
      // more precise Date/time. For example:
      //  - Less precise: `new Date(1581859880000)` == 2020-02-16T13:31:20.000Z
      //  - More precise: `new Date(1581859883747)` == 2020-02-16T13:31:23.747Z
      k += diffkey;
      node1 = node1[diffkey] || {};
      node2 = node2[diffkey] || {};
    }
  }

  function prune(trie, n = 2) {
    // Do nothing if empty
    if (!trie.hash) {
      return trie;
    }

    let keys = getKeys(trie);
    keys.sort();

    let next = { hash: trie.hash };
    keys = keys.slice(-n).map(k => (next[k] = prune(trie[k], n)));

    return next;
  }

  function debug(trie, k = '', indent = 0) {
    const str =
      ' '.repeat(indent) +
      (k !== '' ? `k: ${k} ` : '') +
      `hash: ${trie.hash || '(empty)'}\n`;
    return (
      str +
      getKeys(trie)
        .map(key => {
          return debug(trie[key], key, indent + 2);
        })
        .join('')
    );
  }

  return {
    getKeys,
    keyToTimestamp,
    insert,
    build,
    diff,
    prune,
    debug
  };
});
