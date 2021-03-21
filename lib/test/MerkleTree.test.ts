/// <reference types="../../types/common" />
import { describe, expect, it } from '@jest/globals';
import { fail } from 'assert';

import {
  convertTimeToTreePath,
  MAX_TIME_MSEC,
  MerkleTree,
  MAX_TREEPATH_LENGTH,
  convertTreePathToTime,
  isBaseThreeTreePath,
  BaseThreeTreePath,
} from '../src/MerkleTree';

describe('MerkleTree', () => {
  const plainObjTree: MerkleTreeCompatible = {
    hash: 111 ^ 222 ^ 333,
    branches: {
      '0': {
        hash: 111 ^ 222,
        branches: {
          '0': {
            hash: 111,
            branches: {},
          },
          '2': {
            hash: 222,
            branches: {},
          },
        },
      },
      '2': {
        hash: 333,
        branches: {},
      },
    },
  };

  describe('from(object)', () => {
    it('converts valid object to instance', () => {
      const tree = MerkleTree.fromObj(plainObjTree);
      expect(tree).toEqual(plainObjTree);
    });

    it.each([
      [{}],
      [{ hash: 0 }],
      [{ hash: {} }],
      [{ hash: 0, branches: null }],
      [{ hash: 0, branches: false }],
      [{ hash: 0, branches: 1 }],
      [{ hash: 0, branches: 'foo' }],
      [{ hash: 0, branches: { foo: 'bar' } }],
    ])(`won't convert %s to a tree`, (obj) => {
      expect(() => {
        MerkleTree.fromObj(obj);
      }).toThrow(MerkleTree.InvalidSourceObjectError);
    });
  });

  describe('get(path)', () => {
    const tree = MerkleTree.fromObj(plainObjTree);

    it('finds path to leaf node', () => {
      const found = tree.get(['0', '2']);
      expect(found).toEqual({ hash: 222, branches: {} });
    });

    it('finds path to non-leaf node', () => {
      const found = tree.get(['0']);
      expect(found).toEqual(plainObjTree.branches[0]);
    });

    it('returns null if path is empty', () => {
      expect(tree.get([])).toBeNull();
    });

    it(`returns null if path doesn't exist in tree`, () => {
      expect(tree.get(['0', '2', '1'])).toBeNull();
    });
  });

  describe('set(path, hash)', () => {
    const expected: MerkleTreeCompatible = {
      hash: 111,
      branches: {
        '0': {
          hash: 111,
          branches: {
            '1': {
              hash: 111,
              branches: {
                '2': { hash: 111, branches: {} },
              },
            },
          },
        },
      },
    };

    it('works on a new/empty tree', () => {
      const tree = new MerkleTree();
      tree.set(['0', '1', '2'], 111);
      expect(tree).toEqual(expected);
    });

    it('works on a non-empty tree', () => {
      const tree = MerkleTree.fromObj(expected);
      expect(tree).toEqual(expected);

      tree.set(['0', '2'], 222);
      expect(tree).toEqual({
        hash: 111 ^ 222,
        branches: {
          '0': {
            hash: 111 ^ 222,
            branches: {
              '1': {
                hash: 111,
                branches: {
                  '2': { hash: 111, branches: {} },
                },
              },
              '2': {
                hash: 222,
                branches: {},
              },
            },
          },
        },
      });
    });

    it(`doesn't mutate the tree on repeated attempts to set a path/hash that already exists`, () => {
      const tree = new MerkleTree();
      const originalHash = 111;
      const anotherHash = 222;

      tree.set(['0', '1', '2'], originalHash);
      expect(tree.hash).toEqual(originalHash);

      tree.set(['0', '1', '2'], originalHash);
      expect(tree.hash).toEqual(originalHash);

      tree.set(['0', '2'], anotherHash);
      expect(tree.hash).toEqual(originalHash ^ anotherHash);

      tree.set(['0', '2'], anotherHash);
      expect(tree.hash).toEqual(originalHash ^ anotherHash);
    });
  });

  describe('findDiff(otherTree)', () => {
    it('works when two nodes have a different hash at the same path', () => {
      const tree1 = MerkleTree.fromObj(plainObjTree);
      const tree2 = MerkleTree.fromObj(plainObjTree);

      const diffPath: BaseThreeTreePath = ['0', '1'];
      tree1.set(diffPath, 333);

      expect(tree1.findDiff(tree2)).toEqual(diffPath);
      expect(tree2.findDiff(tree1)).toEqual(diffPath);
    });

    it('works when a one tree has a node the other lacks', () => {
      const tree1 = MerkleTree.fromObj(plainObjTree);
      const tree2 = MerkleTree.fromObj(plainObjTree);

      const diffPath: BaseThreeTreePath = ['0', '0', '1'];
      tree1.set(diffPath, 333);

      expect(tree1.findDiff(tree2)).toEqual(diffPath);
      expect(tree2.findDiff(tree1)).toEqual(diffPath);
    });

    it('finds the FIRST diff when more than one node has a different hash', () => {
      const tree1 = MerkleTree.fromObj(plainObjTree);
      const tree2 = MerkleTree.fromObj(plainObjTree);

      const earlierPath: BaseThreeTreePath = ['0', '2'];
      const laterPath: BaseThreeTreePath = ['2', '1'];
      tree1.set(earlierPath, 333);
      tree1.set(laterPath, 444);

      expect(tree1.findDiff(tree2)).toEqual(earlierPath);
      expect(tree2.findDiff(tree1)).toEqual(earlierPath);
    });

    it('returns empty path when both trees are the same', () => {
      const tree1 = MerkleTree.fromObj(plainObjTree);
      const tree2 = MerkleTree.fromObj(plainObjTree);

      tree1.set(['2', '1'], 333);
      tree2.set(['2', '1'], 333);
      tree1.set(['2', '1', '0'], 4444);
      tree2.set(['2', '1', '0'], 4444);

      expect(tree1.findDiff(tree2)).toEqual([]);
      expect(tree2.findDiff(tree1)).toEqual([]);
    });
  });

  it('pathToOldestLeaf() works', () => {
    const tree = MerkleTree.fromObj(plainObjTree);
    expect(tree.pathToOldestLeaf()).toEqual(['0', '0']);

    tree.set(['2', '1', '2'], 222);
    tree.set(['0', '0', '2'], 111);
    expect(tree.pathToOldestLeaf()).toEqual(['0', '0', '2']);
  });

  it('pathToNewestLeaf() works', () => {
    const tree = MerkleTree.fromObj(plainObjTree);
    expect(tree.pathToNewestLeaf()).toEqual(['2']);

    tree.set(['2', '1', '2'], 222);
    tree.set(['0', '1', '2'], 111);
    expect(tree.pathToNewestLeaf()).toEqual(['2', '1', '2']);
  });

  describe('prune()', () => {
    it('single call works', () => {
      const tree1 = MerkleTree.fromObj(plainObjTree);
      tree1.pruneOldestLeaf();
      expect(tree1.pathToOldestLeaf()).toEqual(['0', '2']);
    });

    it('consecutive calls work', () => {
      const tree1 = MerkleTree.fromObj(plainObjTree);
      tree1.pruneOldestLeaf();
      tree1.pruneOldestLeaf();
      expect(tree1.pathToOldestLeaf()).toEqual(['0']);
    });
  });

  describe('fromTimestamps()', () => {
    //TODO
  });

  describe('convertTimeToTreePath()', () => {
    it('works with the smallest allowed time', () => {
      expect(convertTimeToTreePath(1)).toEqual(['0']);
    });

    it('works with the max time', () => {
      expect(convertTimeToTreePath(MAX_TIME_MSEC)).toEqual('2'.repeat(MAX_TREEPATH_LENGTH).split(''));
    });

    it.each([
      [883747, '112'],
      [1581859883747, '1211121110001201'],
      [2208988800000, '2120021110201100'],
    ])('converts time "%i" to path %s)', (time, expectedPath) => {
      expect(convertTimeToTreePath(time)).toEqual(expectedPath.split(''));
    });

    it('fails with a time too far into the future', () => {
      expect(() => {
        convertTimeToTreePath(MAX_TIME_MSEC + 1);
      }).toThrow(MerkleTree.MaxTimeError);
    });

    it('fails with a time too far into the past', () => {
      expect(() => {
        convertTimeToTreePath(-1);
      }).toThrow(MerkleTree.MinTimeError);
    });
  });

  describe('convertTreePathToTime() works', () => {
    it.each([
      ['0', 0],
      ['1', 2582803260000],
      ['2', 5165606520000],
      ['000', 0],
      ['012', 1434890700000],
    ])('converts path "%s" to time "%i"', (pathStr, expectedTime) => {
      const path = pathStr.split('');
      if (isBaseThreeTreePath(path)) {
        expect(convertTreePathToTime(path)).toEqual(expectedTime);
      } else {
        fail('Received invalid path.');
      }
    });

    it('fails when path is empty', () => {
      expect(() => {
        convertTreePathToTime([]);
      }).toThrow(MerkleTree.MinPathLengthError);
    });
  });
});
