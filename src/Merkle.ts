import { Timestamp } from './Timestamp';

export interface BaseMerkle {
  hash: number;
}

export interface BaseThreeMerkleTree extends BaseMerkle {
  '0'?: BaseThreeMerkleTree;
  '1'?: BaseThreeMerkleTree;
  '2'?: BaseThreeMerkleTree;
}

export type BaseThreeNumber = Exclude<keyof BaseThreeMerkleTree, 'hash'>;

// A tree path is an array of characters, where each character can be used to access the next child node in the tree.
// The path to a node is actually a time: each character in the path is part of a base-3 encoded "minutes since 1970"
// value. We limit how long the paths can be so that, given a "short" path (i.e., only the first few digits of a time
// value), we know how many zeroes to add back to the path so that it represents minutes since 1970.
//
// As a quick example using base-10 digits, imagine a tree path of '267' (e.g., the node with with a different hash
// value is found by using 2 to access the first child, 6 to access the next child, and finally 7). '267' is not the
// actual "minutes since 1970" value--it's only part of that value. `new Date(267 * 60 * 1000)` would result in an
// incorrect time of "1970-01-01T04:27:00". We have to pad the value with zeroes to get a more accurate date: `new
// Date(26700000 * 60 * 1000)` => "2020-10-06T16:00:00".
export type MaxTreePathLength = 17;
export const MAX_TREEPATH_LENGTH: MaxTreePathLength = 17;
export type BaseThreeTreePath = BaseThreeNumber[];

// A "path" to a leaf node should consist of no more than 17 keys. Each key can be a single base-3 digit (0, 1, or 2);
// the largest base-3 number consisting of 17 digits is 22222222222222222, or 129140162 in base 10. (Note that this
// also means the maximum date we support is `new Date(129140162 * 60 * 1000)` => "2215-07-16T16:02:00.000Z".
export const MAX_TIME_MSEC = parseInt('2'.repeat(MAX_TREEPATH_LENGTH), 3) * 60 * 1000;

export class MerkleTree {
  static MinTimeError = class extends Error {
    public type: string;
    public message: string;

    constructor(timeMsec: number) {
      super();
      this.type = 'MinTimeError';
      this.message = `Time '${timeMsec}' is <= 0.`;
    }
  };

  static MaxTimeError = class extends Error {
    public type: string;
    public message: string;

    constructor(timeMsec: number) {
      super();
      this.type = 'MaxTimeError';
      this.message = `Time '${timeMsec}' is greater than limit ('${MAX_TIME_MSEC}').`;
    }
  };

  static MinPathLengthError = class extends Error {
    public type: string;
    public message: string;

    constructor() {
      super();
      this.type = 'MinPathLengthError';
      this.message = `Tree paths must have at least one element.`;
    }
  };

  static MaxPathLengthError = class extends Error {
    public type: string;
    public message: string;

    constructor(treePath: BaseThreeTreePath) {
      super();
      this.type = 'MaxPathLengthError';
      this.message = `Tree path cannot have more than ${MAX_TREEPATH_LENGTH} elements: ${treePath}`;
    }
  };
}

export function build(timestamps: Timestamp[]): BaseThreeMerkleTree {
  const tree = { hash: 0 };
  for (let timestamp of timestamps) {
    insertTimestamp(tree, timestamp);
  }
  return tree;
}

/**
 * Adds a new node (a timestamp) to a merkle tree.
 */
export function insertTimestamp(tree: BaseThreeMerkleTree, timestamp: Timestamp): BaseThreeMerkleTree {
  let treePath = convertTimeToTreePath(timestamp.millis());
  return insertHash(tree, treePath, timestamp.hash());
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
export function insertHash(
  currentNode: BaseThreeMerkleTree,
  treePath: BaseThreeTreePath,
  timestampHash: number
): BaseThreeMerkleTree {
  if (treePath.length === 0) {
    return currentNode;
  } else if (treePath.length > MAX_TREEPATH_LENGTH) {
    throw new MerkleTree.MaxPathLengthError(treePath);
  }

  const childNodeKey = treePath[0];
  const childNode: BaseThreeMerkleTree = currentNode[childNodeKey] || { hash: 0 };

  // Create/rebuild the child node with a (possibly) new hash that incorporates the passed-in hash, and new new/rebuilt
  // children (via a recursive call to `insertKey()`). In other words, since `key.length > 0` we have more "branches" of
  // the tree hierarchy to extend before we reach a leaf node and can begin returning.
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
    insertHash(childNode, treePath.slice(1), timestampHash),

    // Update the current node's hash. If we don't have a hash (i.e., we just created `currChild` and it is an empty
    // object) then this will just be the value of the passed-in hash from our "parent" node. In effect, an "only child"
    // node will have the same hash as its parent; only when a a 2nd (or later)
    { hash: childNode.hash ^ timestampHash }
  );

  // Return a NEW tree that has an updated hash and the updated child node
  return { ...currentNode, hash: currentNode.hash ^ timestampHash, [childNodeKey]: updatedChildNode };
}

/**
 * Returns a path to first node where two trees differ: an array, where each element can be used as a key to retrieve
 * the next child node in the tree. The elements in the array can be concatenated to form a base-3 encoded string that
 * represents minutes since 1970 (this can then be converted to back to a base-10 "milliseconds since 1970" value that
 * then represents an HLC physical clock time when two trees began to have different values).
 */
export function pathToFirstDiff(tree1: BaseThreeMerkleTree, tree2: BaseThreeMerkleTree): BaseThreeTreePath | null {
  if (tree1.hash === tree2.hash) {
    return null;
  }

  let node1 = tree1;
  let node2 = tree2;
  const pathToDiff: BaseThreeTreePath = [];

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
      return pathToDiff;
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
    pathToDiff.push(diffkey);

    if (pathToDiff.length > MAX_TREEPATH_LENGTH) {
      throw new MerkleTree.MaxPathLengthError(pathToDiff);
    }

    // Now update the references to the nodes (from each tree) so that, in the next loop, we are comparing the child
    // nodes (i.e., this is how we recurse the trees).
    node1 = node1[diffkey] || { hash: 0 };
    node2 = node2[diffkey] || { hash: 0 };
  }
}

/**
 * Converts a time, milliseconds since 1970, to minutes, then converts that from a base-10 number to a base-3 number
 * stored as a STRING.
 *
 * This string will be used as a path to navigate the merkle tree: each character is a step in the path used to navigate
 * to the next node in the tree. In other words, the "minutes since 1970" value becomes a "key" that can be used to
 * get/set a value (a hash) in the merkle tree. This means that the tree will consist of nodes that have, at most, 3
 * child nodes (aka, a "ternary" tree, or "trie").
 *
 * You could use a more precise unit of time (e.g., milliseconds instead of minutes), but a more precise time means a
 * bigger number, which would result in a longer "tree path", and therefore more nodes in the merkle tree. In other
 * words, using more precise times would results in a bigger data structure and a slower diffing algorithm (because it
 * has more nodes to go through).
 */
export function convertTimeToTreePath(msecTime: number): BaseThreeTreePath {
  if (msecTime > MAX_TIME_MSEC) {
    throw new MerkleTree.MaxTimeError(msecTime);
  } else if (msecTime < 0) {
    throw new MerkleTree.MinTimeError(msecTime);
  }

  const minutesFloat = msecTime / 1000 / 60;

  // Converting msec to minutes can result in a floating-point number. We don't want decimals our our tree paths, nor do
  // we care about time beyond the minute level. In other words, we want to truncate the (possibly floating-point) value
  // so that we're left with an integer--just the minutes. We can use the bitwise OR operator to do this.
  //
  // In JS, the bitwise operatators only work on 32-bit integers, so before a bitwise expression can be evaluated (e.g.,
  // "a | b"), each operand needs to be converted to a 32-bit int. And as long as one operand is 0, the expression will
  // always evaluate to the _other_ operand--in this case, our "minutes" value--and that operand will have been
  // converted to an integer (e.g., "36816480.016666666 | 0" becomes "36816480").
  const minutesInt = minutesFloat | 0;

  // Use .toString(radix) to convert the number to base-3 (e.g., 36816480 becomes '2120021110201100')
  const baseThreeMinutes = Number(minutesInt).toString(3);

  // Split the string into an array. Technically you could skip this since the string can be used like an array in
  // most cases; we're doing it to make things a bit more explicit/strict.
  const treePath = baseThreeMinutes.split('') as BaseThreeTreePath;

  if (treePath.length > MAX_TREEPATH_LENGTH) {
    throw new MerkleTree.MaxPathLengthError(treePath);
  }

  return treePath;
}

/**
 * Converts a tree path to a time (msec since 1970). Normally this is used to figure out (roughly) when two trees began
 * to differ. Keep in mind that, since a tree path can be short (e.g., a difference is found only 2 nodes into
 * the three, resulting in a path with only 2 elements), the resulting time values can be imprecise. This is ok since
 * the goal is to just establish a time _after which_ messages should be re-synced.
 */
export function convertTreePathToTime(treePath: BaseThreeTreePath): number {
  if (treePath.length === 0) {
    throw new MerkleTree.MinPathLengthError();
  }

  // Only full tree paths (i.e., paths long enough to navigate to a leaf node) have enough digits to safely be converted
  // back to a "minutes since 1970" value as-is. But we can also receive short/partial paths (e.g., maybe a diff is found
  // at the very first node, resulting in a path with only a single character). In other words, we may be getting only
  // the first few digits of a full "minutes since 1970" value. We need to pad that value, ensuring that it has enough
  // base-3 digits to amount to a full "minutes" value.
  let baseThreeMinutesStr = treePath.join('') + '0'.repeat(MAX_TREEPATH_LENGTH - treePath.length);

  // Parse the base 3 representation back into base 10 "msecs since 1970" that can be easily passed to Date()
  const timeMsec = parseInt(baseThreeMinutesStr, 3) * 1000 * 60;

  if (timeMsec > MAX_TIME_MSEC) {
    throw new MerkleTree.MaxTimeError(timeMsec);
  }

  return timeMsec;
}

export function getKeysToChildNodes(tree: BaseThreeMerkleTree): BaseThreeNumber[] {
  return Object.keys(tree).filter((key) => key !== 'hash') as BaseThreeNumber[];
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

export function isBaseThreeTreePath(thing: unknown): thing is BaseThreeTreePath {
  if (Array.isArray(thing) && thing.length <= MAX_TREEPATH_LENGTH) {
    const invalidCharIndex = thing.findIndex((item) => item !== '0' && item !== '1' && item !== '2');
    return invalidCharIndex === -1;
  }
  return false;
}
