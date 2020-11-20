import { jest } from '@jest/globals';
import { BaseThreeMerkleTree, insertKey } from './Merkle';

describe('Merkle', () => {
  describe('insertKey()', () => {
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

    const actualTree = insertKey(originalTree, ['0', '0', '1'], newChildHash);

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
