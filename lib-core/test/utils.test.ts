import { expect, describe, it } from '@jest/globals';
import { makeClientId } from '../src/utils';

describe('utils', () => {
  describe('makeClientId()', () => {
    const clientIds = Array.from({ length: 1000 }, makeClientId);

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
});
