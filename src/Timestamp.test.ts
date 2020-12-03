import { jest } from '@jest/globals';
import murmurhash from 'murmurhash';
import { HLTime, MutableTimestamp } from './Timestamp';

afterEach(() => {
  jest.useRealTimers();
});

describe('HLTime', () => {
  it('constructor works', () => {
    const expected = { millis: 111, counter: 222, node: 'foo' };
    const actualTimestamp = new HLTime(expected.millis, expected.counter, expected.node);
    expect(actualTimestamp.millis()).toEqual(expected.millis);
    expect(actualTimestamp.counter()).toEqual(expected.counter);
    expect(actualTimestamp.node()).toEqual(expected.node);
  });

  it('toString() works', () => {
    const samples = [
      { dateStr: '2020-11-08T17:15:47.036Z', millis: 1604855747036, counter: Number(123), node: 'spongebob' },
      { dateStr: '1987-02-08T17:15:47.036Z', millis: 539802947036, counter: Number(456), node: 'patrick' },
      { dateStr: '2037-03-08T01:15:47.036Z', millis: 2120087747036, counter: Number(789), node: 'squidward' },
    ];
    for (const { dateStr, millis, counter, node } of samples) {
      const actualTimestampStr = new HLTime(millis, counter, node).toString();
      const expectedTimestampStr = [
        dateStr,
        ('0000' + counter.toString(16).toUpperCase()).slice(-4),
        ('0000000000000000' + node).slice(-16),
      ].join('-');
      expect(actualTimestampStr).toEqual(expectedTimestampStr);
    }
  });

  describe('hash()', () => {
    it('returns the same value every time', () => {
      const expectedHash = 4019442025;
      const timestamp = new HLTime(111, 222, 'foo');
      expect(timestamp.hash()).toEqual(expectedHash);
      expect(timestamp.hash()).toEqual(expectedHash);
      expect(timestamp.hash()).toEqual(expectedHash);
    });

    it('returns different value for different timestamp node IDs', () => {
      expect(new HLTime(111, 222, 'foo').hash()).toEqual(4019442025);
      expect(new HLTime(111, 222, 'foo2').hash()).toEqual(1253188043);
    });

    it('returns different value for different timestamp counters', () => {
      expect(new HLTime(111, 222, 'foo').hash()).toEqual(4019442025);
      expect(new HLTime(111, 229, 'foo').hash()).toEqual(3056981850);
    });

    it('returns different value for different timestamp physical times', () => {
      expect(new HLTime(111, 222, 'foo').hash()).toEqual(4019442025);
      expect(new HLTime(119, 222, 'foo').hash()).toEqual(256289245);
    });
  });

  describe('parse()', () => {
    it('converts string to Timestamp instance when given a valid string', () => {
      const expectedCounter = 42;
      const expected = {
        node: '97bf28e64e4128b0',
        counter: '00' + expectedCounter.toString(16),
        time: '2020-02-02T16:29:22.946Z',
      };

      const timestamp = HLTime.parse(`${expected.time}-${expected.counter}-${expected.node}`);

      expect(timestamp).toBeInstanceOf(HLTime);
      expect(timestamp?.node()).toEqual(expected.node);
      expect(timestamp?.counter()).toEqual(expectedCounter);
    });

    it('returns null when given an invalid string', () => {
      expect(HLTime.parse('')).toBeNull();
      expect(HLTime.parse('asdfasdf')).toBeNull();

      // TODO: modify Timestamp.parse() to throw if it receives invalid dates (e.g., 2020-32-02), then add test for that
    });
  });

  it('hash() works', () => {
    const t1 = new HLTime(Date.now(), 123, 'node1');
    const t2 = new HLTime(Date.now() - 12345, 1, 'node2');
    expect(t1.hash()).toEqual(murmurhash(t1.toString()));
    expect(t2.hash()).toEqual(murmurhash(t2.toString()));
  });
});

describe('MutableTimestamp', () => {
  it('constructor works', () => {
    const expected = { millis: 111, counter: 222, node: 'foo' };
    const actualTimestamp = new MutableTimestamp(expected.millis, expected.counter, expected.node);
    expect(actualTimestamp.millis()).toEqual(expected.millis);
    expect(actualTimestamp.counter()).toEqual(expected.counter);
    expect(actualTimestamp.node()).toEqual(expected.node);
  });

  it('setters works', () => {
    const initial = { millis: 111, counter: 222, node: 'foo' };
    const actualTimestamp = new MutableTimestamp(initial.millis, initial.counter, initial.node);

    const expected = { millis: 333, counter: 444, node: 'bar' };
    actualTimestamp.setMillis(expected.millis);
    actualTimestamp.setCounter(expected.counter);
    actualTimestamp.setNode(expected.node);

    expect(actualTimestamp.millis()).toEqual(expected.millis);
    expect(actualTimestamp.counter()).toEqual(expected.counter);
    expect(actualTimestamp.node()).toEqual(expected.node);
  });
});
