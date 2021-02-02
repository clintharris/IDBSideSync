import { expect, describe, it } from '@jest/globals';
import * as utils from '../src/utils';

describe('utils', () => {
  describe('makeNodeId()', () => {
    const clientIds = Array.from({ length: 1000 }, utils.makeNodeId);

    it('returns values in correct format.', () => {
      const lowerAlphaNumRegex = new RegExp('[a-z|\\d]{16}');
      for (let clientId of clientIds) {
        expect(clientId).toMatch(lowerAlphaNumRegex);
        expect(clientId).toHaveLength(16);
      }
    });

    it('returns unique values.', () => {
      const previouslySeenIds = new Set();
      for (let clientId of clientIds) {
        expect(previouslySeenIds).not.toContain(clientId);
        previouslySeenIds.add(clientId);
      }
    });
  });

  describe('isSupportedObjectKey()', () => {
    it.each([
      [1, true],
      [[1, 2], true],
      ['foo', true],
      [['foo', 'bar'], true],
      [{}, false],
      [null, false],
      [undefined, false],
      [new Date(), false],
      [[1, null], false],
    ])('correctly asserts validity of "%s" as a supported object key', (input, expectedResult) => {
      expect(utils.isSupportedObjectKey(input)).toBe(expectedResult);
    });
  });
});
