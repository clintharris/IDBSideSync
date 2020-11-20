import { Timestamp } from './Timestamp';

interface BaseMerkle {
  hash: number;
}

export interface BaseThreeMerkleTree extends BaseMerkle {
  '0'?: BaseThreeMerkleTree;
  '1'?: BaseThreeMerkleTree;
  '2'?: BaseThreeMerkleTree;
}

export type BaseThreeNumber = Exclude<keyof BaseThreeMerkleTree, 'hash'>;

export function build(timestamps: Timestamp[]): BaseThreeMerkleTree {
  const trie = { hash: 0 };
  for (let timestamp of timestamps) {
    insert(trie, timestamp);
  }
  return trie;
}

/**
 * Adds a new node (a timestamp) into a merkle tree.
 */
export function insert(tree: BaseThreeMerkleTree, timestamp: Timestamp): BaseThreeMerkleTree {
  let hash = timestamp.hash();

  // Convert the timestamp's logical time (i.e., its "milliseconds since 1970") to minutes, then convert that to a
  // base-3 STRING. Base 3 meaning: 0 => '0', 1 => '1', 2 => '2', 3 => '10', 2938 => '11000211'.
  //
  // This string will be used as a path to navigate the merkle tree: each character is a step in the path used to
  // navigate to the next node in the trie. In other words, the logical time becomes the "key" that can be used to
  // get/set a value (the timestamp's hash) in the merkle tree.
  //
  // You could use a more precise unit of time (e.g., milliseconds instead of minutes), but a more precise time means a
  // bigger number, which means a longer string, which means more nodes in the merkle tree; in other words, a bigger
  // data structure and a slower diffing algorithm (because it has more nodes to go through).
  //
  // Since we're using base-3, each char in in the path will either be '0', '1', or '2'. This means that the trie will
  // consist of nodes that have, at most, 3 child nodes.
  //
  // Note the use of the bitwise OR operator (`... | 0`). This is a quick way of converting the floating-point value to
  // an integer (in a nutshell: the bitwise operators only work on 32-bit integers, so it causes the 64-bit float to be
  // converted to an integer).) For example, this causes: "1211121022121110.11221000121012222" to become
  // "1211121022121110".
  let key = Number((timestamp.millis() / 1000 / 60) | 0)
    .toString(3)
    .split('') as BaseThreeNumber[];

  // Create a new object that has the same tree and a NEW root hash. Note that "bitwise hashing" is being used here to
  // make a new hash. Bitwise XOR treats both operands as a sequence of 32 bits. It returns a new sequence of 32 bits
  // where each bit is the result of combining the corresponding pair of bits (i.e., bits in the same position) from the
  // operands. It returns a 1 in each bit position for which the corresponding bits of either but not both operands are
  // 1s.
  return insertKey(tree, key, hash);
}

/**
 * Use this function to insert an HLC timestamp's hash into a merkle tree, updating the hashes of all intermediate tree
 * nodes along the way, using the specified "tree path" to determine where in the tree a node should be created or
 * updated.
 *
 * The specified path should be the "physical clock time" portion of an HLC timestamp (i.e., the time at which an oplog
 * entry was created) as MINUTES since 1970, and converted to base-3.
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
 * @returns an object like: { hash: 1234567; '0': object; '1': object; '2': object }
 */
export function insertKey(
  currentNode: BaseThreeMerkleTree,
  childNodeKeys: BaseThreeNumber[],
  timestampHash: number
): BaseThreeMerkleTree {
  if (childNodeKeys.length === 0) {
    return currentNode;
  }

  const childNodeKey = childNodeKeys[0];
  const childNode: BaseThreeMerkleTree = currentNode[childNodeKey] || { hash: 0 };

  // Create/rebuild the child node with a (possibly) new hash that incorporates the passed-in hash, and new new/rebuilt
  // children (via a recursive call to `insertKey()`). In other words, since `key.length > 0` we have more "branches" of
  // the trie hierarchy to extend before we reach a leaf node and can begin returning.
  //
  // The first time the child node is built, it will have hash A. If another timestamp hash (B) is inserted, and this
  // node is a "step" in the insertion path (i.e., it is the target node or a parent of the target node), then the has
  // will be updated to be hash(A, B).
  const updatedChildNode: BaseThreeMerkleTree = Object.assign(
    {},
    childNode,

    // Note that we're using key.slice(1) to make sure that, for the next recursive call, we are moving on to the next
    // "step" in the "path" (i.e., the next character in the key string). If `key.slice() === ''` then `insertKey()`
    // will return `currChild`--in which case all we are doing here is setting the `hash` property.
    insertKey(childNode, childNodeKeys.slice(1), timestampHash),

    // Update the current node's hash. If we don't have a hash (i.e., we just created `currChild` and it is an empty
    // object) then this will just be the value of the passed-in hash from our "parent" node. In effect, an "only child"
    // node will have the same hash as its parent; only when a a 2nd (or later)
    { hash: childNode.hash ^ timestampHash }
  );

  // Return a NEW tree that has an updated hash and the updated child node
  return { ...currentNode, hash: currentNode.hash ^ timestampHash, [childNodeKey]: updatedChildNode };
}

/**
 * Returns a number representing the earliest known time when two merkle trees had different hashes (in milliseconds
 * since 1970), or null if the trees have the same hashes.
 */
export function diff(tree1: BaseThreeMerkleTree, tree2: BaseThreeMerkleTree): number | null {
  if (tree1.hash === tree2.hash) {
    return null;
  }

  let node1 = tree1;
  let node2 = tree2;
  let pathToDiff = '';

  while (true) {
    // At this point we have two node objects. Each of those objects will have some properties like '0', '1', '2', or
    // 'hash'. The numeric props (note that they are strings) are what we care about--they are the keys we can use to
    // access child nodes, and we will use them to compare the two nodes.
    //
    // Get all the keys to child nodes from both trees, using a Set() to remove duplicates.
    let childNodeKeySet = new Set([...getKeysToChildNodes(node1), ...getKeysToChildNodes(node2)]);
    let childNodeKeys = [...childNodeKeySet.values()]; // Convert the set to an array

    // Before we start to compare the two nodes we want to sort the keys so that, in effect, we are "moving" from older
    // times to more recent times when doing the diff. This way, if there is a difference, we will have found the oldest
    // time at which the trees began to differ.
    childNodeKeys.sort();

    // Compare the hash for each of the child nodes, returning the key of the first child node for which hashes differ.
    let diffkey = childNodeKeys.find((key) => {
      return node1[key]?.hash !== node2[key]?.hash;
    });

    // If we didn't find anything, it means the child nodes have the same hashes (i.e., this is a "point in time" when
    // both trees are the same).
    if (!diffkey) {
      return base3EncodedMinutesToMsec(pathToDiff);
    }

    // If we got this far, it means we found a location where the two trees differ (i.e., each tree has a child node at
    // this position, but they have different hashes--meaning they are the result of different messages). We want to
    // continue down this path and keep comparing nodes until we can find a position where the hashes equal.
    //
    // Note that as we continue to recurse the tree, we are appending the keys. This string of digits will be parsed
    // back intoa time eventually, so as we keep appending characters we are basically building a more and more precise
    // Date/time. For example:
    //  - Less precise: `new Date(1581859880000)` == 2020-02-16T13:31:20.000Z
    //  - More precise: `new Date(1581859883747)` == 2020-02-16T13:31:23.747Z
    pathToDiff += diffkey;

    // Now update the references to the nodes (from each tree) so that, in the next loop, we are comparing the child
    // nodes (i.e., this is how we recurse the trees).
    node1 = node1[diffkey] || { hash: 0 };
    node2 = node2[diffkey] || { hash: 0 };
  }
}

export function getKeysToChildNodes(tree: BaseThreeMerkleTree): BaseThreeNumber[] {
  return Object.keys(tree).filter((key) => key !== 'hash') as BaseThreeNumber[];
}

/**
 * Converts a time (minutes since 1970) that is a base-3 encoded string back to an actual "milliseconds since 1970"
 * numeric time.
 */
export function base3EncodedMinutesToMsec(base3EncodedMinutes: string): number {
  // 16 is the length of the base 3 value of the current time in minutes. Ensure it's padded to create the full value
  let fullkey = base3EncodedMinutes + '0'.repeat(16 - base3EncodedMinutes.length);

  // Parse the base 3 representation back into base 10 "msecs since 1970" that can be easily passed to Date()
  return parseInt(fullkey, 3) * 1000 * 60;
}

/**
 * Use this function to "prune" a Merkle tree by removing branches. By default, the first branch from each child node
 * is removed.
 */
export function prune(tree: BaseThreeMerkleTree, n = 2): BaseThreeMerkleTree {
  // Do nothing if empty
  if (!tree.hash) {
    return tree;
  }

  let prunedTree: BaseThreeMerkleTree = { hash: tree.hash };

  getKeysToChildNodes(tree)
    .sort()
    .forEach((childNodeKey) => {
      const childTree = tree[childNodeKey];
      if (childTree) {
        prunedTree[childNodeKey] = prune(childTree, n);
      }
    });

  return prunedTree;
}

/**
 * Returns a nicely-indented, stringified version of the tree.
 */
export function stringify(tree: BaseThreeMerkleTree, k = '', indent = 0): string {
  const str = ' '.repeat(indent) + (k !== '' ? `${k}: ` : '') + `${tree.hash || '(empty)'}\n`;

  return (
    str +
    getKeysToChildNodes(tree)
      .map((childNodeKey) => {
        const childTree = tree[childNodeKey];
        if (childTree) {
          return stringify(childTree, childNodeKey, indent + 2);
        }
        return '';
      })
      .join('')
  );
}
