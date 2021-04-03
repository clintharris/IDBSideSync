import { HLTime } from './HLTime';

export type BaseThreeNumber = '0' | '1' | '2';

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
export type BaseThreeTreePath = BaseThreeNumber[];

export const MAX_TREEPATH_LENGTH: MaxTreePathLength = 17;
const BASE_THREE_SET: BaseThreeNumber[] = ['0', '1', '2'];

// A "path" to a leaf node should consist of no more than 17 keys. Each key can be a single base-3 digit (0, 1, or 2);
// the largest base-3 number consisting of 17 digits is 22222222222222222, or 129140162 in base 10. (Note that this
// also means the maximum date we support is `new Date(129140162 * 60 * 1000)` => "2215-07-16T16:02:00.000Z".
export const MAX_TIME_MSEC = parseInt('2'.repeat(MAX_TREEPATH_LENGTH), 3) * 60 * 1000;

export class MerkleTree {
  // Initialize the hash to 0 so that if it updated to be the result of `0 ^ x`, x will always be used as the new hash
  // value (i.e., the first time a "real" hash value is assigned, that value should be used).
  public hash: number = 0;

  public branches: {
    '0'?: MerkleTree;
    '1'?: MerkleTree;
    '2'?: MerkleTree;
  } = {};

  insertHLTime(time: HLTime): void {
    this.set(convertTimeToTreePath(time.millis()), time.hash());
  }

  /**
   * Use this function to insert a hash into the merkle tree, updating the hashes of all intermediate tree nodes along
   * the way, using the specified "tree path" to determine where in the tree a node should be created or updated.
   *
   * The specified path should be the "physical clock time" portion of an HLC timestamp (i.e., the time at which an
   * oplog entry was created) as MINUTES since 1970, and converted to base-3.
   */
  set(treePath: BaseThreeTreePath, hash: number): void {
    if (!treePath || treePath.length === 0) {
      return;
    } else if (treePath.length > MAX_TREEPATH_LENGTH) {
      throw new MerkleTree.MaxPathLengthError(treePath);
    }

    // If the specified hash value already exists at the specified path, it means this tree has already encountered an
    // oplog message; don't continue. We don't want to allow the same oplog message to be ingested more than once; that
    // would result in mutating the hash values, which means two trees would only be equal if _both_ of them had
    // processed the same oplog message twice.
    const existingNode = this.get(treePath);
    if (existingNode && existingNode.hash === hash) {
      return;
    }

    this.hash = this.hash ^ hash;
    let branches = this.branches;
    for (const branchKey of treePath) {
      let branch = branches[branchKey] || new MerkleTree();
      if (!branches[branchKey]) {
        branches[branchKey] = branch;
      }
      branch.hash = branch.hash ^ hash;
      branches = branch.branches;
    }
  }

  get(treePath: BaseThreeTreePath): MerkleTree | null {
    if (!treePath || treePath.length === 0) {
      return null;
    }

    let branches = this.branches;
    let tree = null;

    for (const branchKey of treePath) {
      tree = branches[branchKey];
      if (!tree) {
        return null;
      }
      branches = tree.branches;
    }

    return tree;
  }

  /**
   * Compares two trees, node by node, and returns path to first node that has a different hash value (or null if no
   * difference is found).
   *
   * @returns `BaseThreeTreePath` to the node where the trees begin to differ (if they differ at the root node, this
   * will be an empty array), or `null` if the trees are the same (i.e., no difference exists).
   */
  findDiff(otherTree: MerkleTree): BaseThreeTreePath | null {
    // If the hash values match at the root of each tree, there's no need to go through the child nodes...
    if (this.hash === otherTree.hash) {
      return null;
    }

    let tree1Iter: MerkleTree = this;
    let tree2Iter: MerkleTree = otherTree;
    const pathToDiff: BaseThreeTreePath = [];

    while (true) {
      // Get all the keys to child nodes from both trees, using a Set() to remove duplicates.
      let childTreeKeySet = new Set([...tree1Iter.branchKeys(), ...tree2Iter.branchKeys()]);
      let childTreeKeys = [...childTreeKeySet.values()]; // Convert the set to an array

      // Before we start to compare the two nodes we want to sort the keys so that, in effect, we are "moving" from
      // older times to more recent times when doing the diff. This way, if there is a difference, we will have found
      // the oldest time at which the trees began to differ.
      childTreeKeys.sort();

      // Compare the hash for each of the child nodes, returning the key of the first child node for which hashes
      // differ.
      /* eslint-disable no-loop-func */
      let diffkey = childTreeKeys.find((key) => {
        return tree1Iter.branches[key]?.hash !== tree2Iter.branches[key]?.hash;
      });

      // If we didn't find anything, it means the child nodes have the same hashes (i.e., this is a "point in time" when
      // both trees are the same).
      if (!diffkey) {
        return pathToDiff;
      }

      // If we got this far, it means we found a location where the two trees differ (i.e., each tree has a child node
      // at this position, but they have different hashes--meaning they are the result of different messages). We want
      // to continue down this path and keep comparing nodes until we can find a position where the hashes equal.
      //
      // Note that as we continue to recurse the tree, we are appending the keys. This string of digits will be parsed
      // back intoa time eventually, so as we keep appending characters we are basically building a more and more
      // precise Date/time. For example:
      //  - Less precise: `new Date(1581859880000)` == 2020-02-16T13:31:20.000Z
      //  - More precise: `new Date(1581859883747)` == 2020-02-16T13:31:23.747Z
      pathToDiff.push(diffkey);

      if (pathToDiff.length > MAX_TREEPATH_LENGTH) {
        throw new MerkleTree.MaxPathLengthError(pathToDiff);
      }

      // Now update the references to the nodes (from each tree) so that, in the next loop, we are comparing the child
      // nodes (i.e., this is how we recurse the trees).
      tree1Iter = tree1Iter.branches[diffkey] || new MerkleTree();
      tree2Iter = tree2Iter.branches[diffkey] || new MerkleTree();
    }
  }

  /**
   * Use this to delete the oldest leaf node. This can be useful if the tree has become unnecessarily large with
   * nodes/hashes for oplog messages too old to still be relevant.
   *
   * IMPORTANT: this does not recalculate/update hash values (i.e., it can leave some nodes with hash values that,
   * technically, are not the derived from the hashes of all children). This is ok. If two clients have encountered the
   * same oplog messages (i.e., have the same trees), and one client prunes its tree, the trees should still be
   * considered equal.
   */
  pruneOldestLeaf(): void {
    if (!this.hasBranches()) {
      return;
    }

    for (let [key, childBranch] of this.branchEntries().slice(0, 1)) {
      if (childBranch.hasBranches()) {
        childBranch.pruneOldestLeaf();
      } else {
        delete this.branches[key];
      }
    }
  }

  pathToOldestLeaf(): BaseThreeTreePath {
    const path: BaseThreeTreePath = [];
    let node: MerkleTree = this;
    while (true) {
      let keys = node.branchKeys();
      if (keys.length === 0) {
        return path;
      }
      path.push(keys[0]);
      node = node.branches[keys[0]] as MerkleTree;
    }
  }

  pathToNewestLeaf(): BaseThreeTreePath {
    const path: BaseThreeTreePath = [];
    let node: MerkleTree = this;
    while (true) {
      let keys = node.branchKeys();
      if (keys.length === 0) {
        return path;
      }
      const lastIndex = keys.length - 1;
      path.push(keys[lastIndex]);
      node = node.branches[keys[lastIndex]] as MerkleTree;
    }
  }

  branchKeys(): BaseThreeNumber[] {
    return Object.keys(this.branches)
      .filter((key) => isBaseThreeNumber(key))
      .sort() as BaseThreeNumber[];
  }

  branchEntries(): [BaseThreeNumber, MerkleTree][] {
    const entries: [BaseThreeNumber, MerkleTree][] = [];
    for (let key of this.branchKeys()) {
      let branch = this.branches[key];
      if (branch) {
        entries.push([key, branch]);
      }
    }
    return entries;
  }

  hasBranches(): boolean {
    return this.branchKeys().length > 0;
  }

  /**
   * Add an ES6 standard iterator implementation to make `for (let branch in tree)` expressions possible, etc.
   */
  [Symbol.iterator]() {
    const branchKeys = this.branchKeys();
    return {
      next: () => {
        const key = branchKeys.shift();
        return key ? { value: this.branches[key], done: false } : { done: true };
      },
    };
  }

  toJSON(): object {
    const obj: MerkleTreeCompatible = { hash: this.hash, branches: {} };
    for (const [key, branch] of this.branchEntries()) {
      obj.branches[key as BaseThreeNumber] = branch.toJSON();
    }
    return obj;
  }

  toString(): string {
    return MerkleTree.stringify(this);
  }

  static fromObj(obj: unknown): MerkleTree {
    if (!MerkleTree.canBeCreatedFrom(obj)) {
      throw new MerkleTree.InvalidSourceObjectError(obj);
    }

    const tree = new MerkleTree();
    tree.hash = obj.hash;
    tree.branches = {};

    for (let branchKey of BASE_THREE_SET) {
      if (obj.branches[branchKey]) {
        tree.branches[branchKey] = MerkleTree.fromObj(obj.branches[branchKey]);
      }
    }

    return tree;
  }

  static fromTimestamps(timestamps: HLTime[]): MerkleTree {
    const tree = new MerkleTree();
    for (let timestamp of timestamps) {
      tree.set(convertTimeToTreePath(timestamp.millis()), timestamp.hash());
    }
    return tree;
  }

  /**
   * Returns a nicely-indented, stringified version of the tree.
   */
  static stringify(tree: MerkleTree, key = '', indent = 0): string {
    let str = ' '.repeat(indent) + `[${key === '' ? '-' : key}]: ${tree.hash}\n`;

    for (const [key, branch] of Object.entries(tree.branches)) {
      str += branch ? MerkleTree.stringify(branch, key, indent + 4) : '';
    }

    return str;
  }

  static canBeCreatedFrom(obj: unknown): obj is MerkleTreeCompatible {
    if (!obj || typeof obj !== 'object') {
      return false;
    }

    const test = obj as MerkleTree;

    if (typeof test.hash !== 'number') {
      return false;
    }

    if (!test.branches || typeof test.branches !== 'object') {
      return false;
    }

    const invalidBranchKey = Object.keys(test.branches).find((key) => !isBaseThreeNumber(key));
    if (invalidBranchKey) {
      return false;
    }

    return true;
  }

  static MinTimeError = class MinTimeError extends Error {
    constructor(timeMsec: unknown) {
      super(`Time '${timeMsec}' is <= 0.`);
      Object.setPrototypeOf(this, MinTimeError.prototype); // https://git.io/vHLlu
    }
  };

  static MinPathLengthError = class MinPathLengthError extends Error {
    constructor() {
      super(`Tree paths must have at least one element.`);
      Object.setPrototypeOf(this, MinPathLengthError.prototype); // https://git.io/vHLlu
    }
  };

  static MaxTimeError = class MaxTimeError extends Error {
    // Constructor param must be of type `unknown` to avoid TypeScript/Jest error: https://git.io/JqCDN
    constructor(timeMsec: unknown) {
      super(`Time '${timeMsec}' is greater than limit ('${MAX_TIME_MSEC}').`);
      Object.setPrototypeOf(this, MaxTimeError.prototype); // https://git.io/vHLlu
    }
  };

  static InvalidSourceObjectError = class InvalidSourceObjectError extends Error {
    // Constructor param must be of type `unknown` to avoid TypeScript/Jest error: https://git.io/JqCDN
    constructor(object: unknown) {
      super(`Can't create tree from object: ` + JSON.stringify(object));
      Object.setPrototypeOf(this, InvalidSourceObjectError.prototype); // https://git.io/vHLlu
    }
  };

  static MaxPathLengthError = class MaxPathLengthError extends Error {
    constructor(treePath: BaseThreeTreePath) {
      super(`Tree path cannot have more than ${MAX_TREEPATH_LENGTH} elements: ${treePath}`);
      Object.setPrototypeOf(this, MaxPathLengthError.prototype); // https://git.io/vHLlu
    }
  };
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
 * words, using more precise times results in a bigger data structure and a slower diffing algorithm (because it has
 * more nodes to go through).
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

  const paddedBaseThreeMinutes = '0'.repeat(MAX_TREEPATH_LENGTH - baseThreeMinutes.length) + baseThreeMinutes;

  // Split the string into an array. Technically you could skip this since the string can be used like an array in
  // most cases; we're doing it to make things a bit more explicit/strict.
  const treePath = paddedBaseThreeMinutes.split('') as BaseThreeTreePath;

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
  // back to a "minutes since 1970" value as-is. But we can also receive short/partial paths (e.g., maybe a diff is
  // found at the very first node, resulting in a path with only a single character). In other words, we may be getting
  // only the first few digits of a full "minutes since 1970" value. We need to pad that value, ensuring that it has
  // enough base-3 digits to amount to a full "minutes" value.
  let baseThreeMinutesStr = treePath.join('') + '0'.repeat(MAX_TREEPATH_LENGTH - treePath.length);

  // Parse the base 3 representation back into base 10 "msecs since 1970" that can be easily passed to Date()
  const timeMsec = parseInt(baseThreeMinutesStr, 3) * 1000 * 60;

  if (timeMsec > MAX_TIME_MSEC) {
    throw new MerkleTree.MaxTimeError(timeMsec);
  }

  return timeMsec;
}

/**
 * TypeScript type guard for safely asserting that something is a BaseThreeNumber.
 */
export function isBaseThreeNumber(thing: unknown): thing is BaseThreeNumber {
  return thing === '0' || thing === '1' || thing === '2';
}

/**
 * TypeScript type guard for safely asserting that something is a BaseThreeTreePath.
 */
export function isBaseThreeTreePath(thing: unknown): thing is BaseThreeTreePath {
  if (Array.isArray(thing) && thing.length <= MAX_TREEPATH_LENGTH) {
    const invalidCharIndex = thing.findIndex((item) => item !== '0' && item !== '1' && item !== '2');
    return invalidCharIndex === -1;
  }
  return false;
}
