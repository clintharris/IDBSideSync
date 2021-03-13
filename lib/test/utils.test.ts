/// <reference types="../../types/common" />
import { expect, describe, it } from '@jest/globals';
import * as utils from '../src/utils';
import { makeNodeId } from '../src/utils';

describe('utils', () => {
  const unsupportedObjectKeys = [{}, null, undefined, new Date(), [1, {}], [1, null], [1, undefined], [1, new Date()]];

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
      ...unsupportedObjectKeys.map((invalidKey) => [invalidKey, false]),
    ])('correctly asserts validity of "%s" as a supported object key', (input, expectedResult) => {
      expect(utils.isSupportedObjectKey(input)).toBe(expectedResult);
    });
  });

  describe('isValidOplogEntry()', () => {
    const oplogEntry: OpLogEntry = {
      hlcTime: `2021-01-24T13:23:14.203Z-0000-${makeNodeId}`,
      objectKey: 1,
      prop: 'id',
      store: 'someStore',
      value: 'someValue',
    };

    it('returns false if oplog entry is missing a required property', () => {
      for (let key in oplogEntry) {
        const { [key as keyof OpLogEntry]: pluckedKey, ...entrySansProp } = oplogEntry;
        expect(utils.isValidOplogEntry(entrySansProp)).toBe(false);
      }
    });

    it.each([
      null,
      false,
      '',
      123,
      'foo',
      oplogEntry.hlcTime.replace('-0000', ''),
      oplogEntry.hlcTime.replace('2021', '21'),
    ])('returns false if oplog entry has invalid HLC timestamp "%s"', (borkedTimestamp) => {
      const borkedEntry = { ...oplogEntry, hlcTime: borkedTimestamp };
      expect(utils.isValidOplogEntry(borkedEntry)).toBe(false);
    });

    it.each([...unsupportedObjectKeys.map((invalidKey) => [invalidKey])])(
      'returns false if oplog entry.objectKey is "%s"',
      (borkedObjectKey) => {
        const borkedEntry = { ...oplogEntry, objectKey: borkedObjectKey };
        expect(utils.isValidOplogEntry(borkedEntry)).toBe(false);
      }
    );

    it.each([undefined, null, false, '', 123, {}, new Date(), []])(
      'returns false if oplog entry.store is "%s"',
      (boredStore) => {
        const borkedEntry = { ...oplogEntry, store: boredStore };
        expect(utils.isValidOplogEntry(borkedEntry)).toBe(false);
      }
    );

    it.each([undefined, null, false, 123, {}, new Date(), []])(
      'returns false if oplog entry.prop is "%s"',
      (borkedProp) => {
        const borkedEntry = { ...oplogEntry, prop: borkedProp };
        expect(utils.isValidOplogEntry(borkedEntry)).toBe(false);
      }
    );
  });
});
