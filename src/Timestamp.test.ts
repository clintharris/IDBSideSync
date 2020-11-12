import { jest } from '@jest/globals';
import { Timestamp, MutableTimestamp, HLC_CONFIG } from './Timestamp';
import { makeClock } from './Clock';

afterEach(() => {
  jest.useRealTimers();
});

describe('Timestamp', () => {
  it('constructor works', () => {
    const expected = { millis: 111, counter: 222, node: 'foo' };
    const actualTimestamp = new Timestamp(expected.millis, expected.counter, expected.node);
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
      const actualTimestampStr = new Timestamp(millis, counter, node).toString();
      const expectedTimestampStr = [
        dateStr,
        ('0000' + counter.toString(16).toUpperCase()).slice(-4),
        ('0000000000000000' + node).slice(-16),
      ].join('-');
      expect(actualTimestampStr).toEqual(expectedTimestampStr);
    }
  });

  describe('send()', () => {
    it('advances clock time to "now" if its physical time occurs before "now"', () => {
      const mockNowTime = overrideSystemTime('2020-01-01T00:00:01Z');

      const clock = makeClock(new Timestamp(Date.parse('04 Dec 1995 00:12:00 GMT'), 123, 'node1'));
      Timestamp.send(clock);

      // The clock should have been advanced and the counter reset to 0
      expect(clock.timestamp.millis()).toEqual(mockNowTime);
      expect(clock.timestamp.counter()).toEqual(0);
    });

    it('increments clock counter if its physical time is "now"', () => {
      const mockNowTime = overrideSystemTime('2020-01-01T00:00:01Z');
      const counter = 123;

      const clock = makeClock(new Timestamp(mockNowTime, counter, 'node1'));
      Timestamp.send(clock);

      expect(clock.timestamp.millis()).toEqual(mockNowTime);
      expect(clock.timestamp.counter()).toEqual(counter + 1);
    });

    it(`throws an error if local physical time occurs _before_ HLC's physical time`, () => {
      const clock = makeClock(new Timestamp(Date.now(), 0, 'node1'));

      // Set local system time to be in the past (i.e., a time that occurs _before_ that of the HLC clock's time).
      overrideSystemTime('2014-01-09T00:00:00Z');

      expect(() => {
        // The attempt to advance the passed-in clock's time should fail due to its time occuring _after_ the local
        // system's current time by a substantial amount (i.e., this simulates an oplog message from a system whose
        // clock is really out of whack--or possibly the local system's clock being really off).
        Timestamp.send(clock);
      }).toThrow(Timestamp.ClockDriftError);
    });

    it(`throws an error once counter value exceeds threshold`, () => {
      // "Freeze" local system time. We need to do this so that each time Timestamp.send() is called, it sees "now"
      // as being the same time as that of the HLC clock instance we're passing in. Only then, if the passed-in clock
      // and the system clock have the same times, will it "resort" to incrementing the counter (which is what we are
      // testing here).
      const mockNowTime = overrideSystemTime('2020-01-01T00:00:01Z');

      // Timer doesn't support count values greater than 65535 because it needs to ensure that, when the count is
      // converted to a hex string, it doesn't use more than 4 chars (see Timestamp.toString).
      const counterThreshold = HLC_CONFIG.maxCounter;
      const initialCounterValue = counterThreshold - 10;

      const clock = makeClock(new Timestamp(Date.now(), initialCounterValue, 'node1'));
      for (let i = initialCounterValue; i < counterThreshold; i++) {
        Timestamp.send(clock);
        expect(clock.timestamp.millis()).toEqual(mockNowTime);
        expect(clock.timestamp.counter()).toEqual(i + 1);
      }

      // At this point, the HLC clock instance's counter should be just under the threshold. Calling Timestamp.send()
      // and attempting to advance the time (i.e., increment the counter) should push the counter over the limit and
      // cause an error to be thrown.
      expect(() => {
        // The attempt to advance the passed-in clock's time should fail due to its time occuring _after_ the local
        // system's current time by a substantial amount (i.e., this simulates an oplog message from a system whose
        // clock is really out of whack--or possibly the local system's clock being really off).
        Timestamp.send(clock);
      }).toThrow(Timestamp.OverflowError);
    });
  });

  it('recv() works', () => {
    // TODO
  });

  it('parse() works', () => {
    // TODO
  });

  it('since() works', () => {
    // TODO
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

function overrideSystemTime(dateStr: string): number {
  const mockNowTime = new Date(dateStr).getTime();
  jest.useFakeTimers('modern');
  jest.setSystemTime(mockNowTime);
  return mockNowTime;
}
