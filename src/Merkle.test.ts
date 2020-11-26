import { jest } from '@jest/globals';
import {
  BaseThreeMerkleTree,
  insertHash,
  convertTimeToTreePath,
  MAX_TIME_MSEC,
  MerkleTree,
  MAX_TREEPATH_LENGTH,
  convertTreePathToTime,
  isBaseThreeTreePath,
  getKeysToChildTrees,
  stringify,
  pathToFirstDiff,
} from './Merkle';

describe('Merkle', () => {
  describe('getKeysToChildTrees()', () => {
    it.each([
      [{ hash: 0, '0': undefined }, ['0']],
      [{ hash: 0, '0': undefined, '1': undefined }, ['0', '1']],
      [{ hash: 0, '0': undefined, '1': undefined, '2': undefined }, ['0', '1', '2']],
      [{ hash: 0, '0': undefined, foo: 'bar' }, ['0']],
    ])('gets from "%s" keys "%s"', (merkleTree, expectedKeys) => {
      expect(getKeysToChildTrees(merkleTree)).toEqual(expectedKeys);
    });
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

  describe('pathToFirstDiff()', () => {
    const defaultLeafNode: BaseThreeMerkleTree = { hash: 1 };
    const diffLeafNode: BaseThreeMerkleTree = { hash: 2 };
    const tree1: BaseThreeMerkleTree = {
      hash: 0,
      '0': {
        hash: 0,
        '0': defaultLeafNode,
        '1': defaultLeafNode,
        '2': defaultLeafNode,
      },
      '2': {
        hash: 0,
        '1': defaultLeafNode,
        '2': defaultLeafNode,
      },
    };

    it('finds diff when two nodes have a different hash', () => {
      const tree2: BaseThreeMerkleTree = JSON.parse(JSON.stringify(tree1));
      tree2.hash = tree1.hash + 1;
      if (tree2[2]) {
        tree2[2].hash = tree2[2].hash + 1;
        tree2[2][1] = diffLeafNode;
      }
      expect(pathToFirstDiff(tree1, tree2)).toEqual(['2', '1']);
    });

    it('finds diff when a one tree has an extra node', () => {
      const tree2: BaseThreeMerkleTree = JSON.parse(JSON.stringify(tree1));
      tree2.hash = tree1.hash + 1;
      if (tree2[2]) {
        tree2[2].hash = tree2[2].hash + 1;
        tree2[2][0] = diffLeafNode;
      }
      expect(pathToFirstDiff(tree1, tree2)).toEqual(['2', '0']);
    });

    it('finds diff when a one tree lacks a node', () => {
      const tree2: BaseThreeMerkleTree = JSON.parse(JSON.stringify(tree1));
      tree2.hash = tree1.hash + 1;
      if (tree2[2]) {
        tree2[2].hash = tree2[2].hash + 1;
        delete tree2[2][1];
      }
      expect(pathToFirstDiff(tree1, tree2)).toEqual(['2', '1']);
    });

    it('finds the FIRST diff when more than one node has a different hash', () => {
      const tree2: BaseThreeMerkleTree = JSON.parse(JSON.stringify(tree1));
      tree2.hash = tree1.hash + 1;
      if (tree2[2]) {
        tree2[2].hash = tree2[2].hash + 1;
        tree2[2][1] = diffLeafNode;
        tree2[2][2] = diffLeafNode;
      }
      expect(pathToFirstDiff(tree1, tree2)).toEqual(['2', '1']);
    });
  });

  describe('insertHash()', () => {
    const originalChild2Hash = 123;
    const originalChild1Hash = originalChild2Hash;
    const originalRootHash = originalChild2Hash;

    const originalTree: BaseThreeMerkleTree = {
      hash: originalRootHash,
      '0': {
        hash: originalChild1Hash,
        '0': {
          hash: originalChild2Hash,
        },
        '2': {
          hash: 555,
        },
      },
    };

    const newChildHash = 333;

    const expectedTree: BaseThreeMerkleTree = {
      hash: originalRootHash ^ newChildHash,
      '0': {
        hash: originalChild1Hash ^ newChildHash,
        '0': {
          hash: originalChild2Hash ^ newChildHash,
          '1': {
            hash: newChildHash,
          },
        },
        '2': {
          hash: 555,
        },
      },
    };

    const actualTree = insertHash(originalTree, ['0', '0', '1'], newChildHash);

    it('returns a new object', () => {
      expect(actualTree !== originalTree).toBeTruthy();
    });

    it('does not mutate the passed-in tree', () => {
      expect(JSON.stringify(originalTree)).toEqual(
        `{"0":{"0":{"hash":${originalChild2Hash}},"2":{"hash":555},"hash":${originalChild1Hash}},"hash":${originalRootHash}}`
      );
    });

    it('returns a tree with correctly-inserted hash', () => {
      expect(actualTree).toEqual(expectedTree);
    });
  });
});
