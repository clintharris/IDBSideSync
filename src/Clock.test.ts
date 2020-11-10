import * as Clock from './Clock';
import { Timestamp } from './Timestamp';

describe('Clock', () => {
  describe('makeClientId()', () => {
    const clientIds = Array.from({ length: 1000 }, Clock.makeClientId);

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

  it('makeClock() returns expected value.', () => {
    const expectedTimestamp = new Timestamp(1, 2, 'foo');
    const merkel = {};
    const { timestamp: actualTimestamp } = Clock.makeClock(expectedTimestamp, merkel);
    expect(actualTimestamp.millis).toEqual(expectedTimestamp.millis);
    expect(actualTimestamp.counter).toEqual(expectedTimestamp.counter);
    expect(actualTimestamp.node).toEqual(expectedTimestamp.node);
  });

  it('setClock() and getClock() work.', () => {
    const clockIn = Clock.makeClock(new Timestamp(1, 2, 'foo'));
    Clock.setClock(clockIn);
    const clockOut = Clock.getClock();
    expect(clockIn).toEqual(clockOut);
  });

  it('serializeClock() returns expected value.', () => {
    const expectedMillis = 1;
    const expectedCounter = 2;
    const expectedNode = 'foo';
    const clock = Clock.makeClock(new Timestamp(expectedMillis, expectedCounter, expectedNode));
    const expectedJson = `{\"timestamp\":\"1970-01-01T00:00:00.00${expectedMillis}Z-000${expectedCounter}-0000000000000${expectedNode}\",\"merkle\":{}}`;
    const actualJson = Clock.serializeClock(clock);
    expect(actualJson).toEqual(expectedJson);
  });
});
