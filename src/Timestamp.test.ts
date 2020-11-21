import { jest } from '@jest/globals';
import murmurhash from 'murmurhash';
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

  describe('hash()', () => {
    it('returns the same value every time', () => {
      const expectedHash = 4019442025;
      const timestamp = new Timestamp(111, 222, 'foo');
      expect(timestamp.hash()).toEqual(expectedHash);
      expect(timestamp.hash()).toEqual(expectedHash);
      expect(timestamp.hash()).toEqual(expectedHash);
    });

    it('returns different value for different timestamp node IDs', () => {
      expect(new Timestamp(111, 222, 'foo').hash()).toEqual(4019442025);
      expect(new Timestamp(111, 222, 'foo2').hash()).toEqual(1253188043);
    });

    it('returns different value for different timestamp counters', () => {
      expect(new Timestamp(111, 222, 'foo').hash()).toEqual(4019442025);
      expect(new Timestamp(111, 229, 'foo').hash()).toEqual(3056981850);
    });

    it('returns different value for different timestamp physical times', () => {
      expect(new Timestamp(111, 222, 'foo').hash()).toEqual(4019442025);
      expect(new Timestamp(119, 222, 'foo').hash()).toEqual(256289245);
    });
  })

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

    it(`advances clock time to HLC's time if it is more recent, within allowed threshold`, () => {
      const hlcTime = Date.now();
      const hlcCounter = 0;

      const hlc = makeClock(new Timestamp(hlcTime, hlcCounter, 'node1'));

      // Set local system time to be in the past (relative to the HLC), but not _too far_ in the past...
      const past = new Date(hlcTime - HLC_CONFIG.maxDrift);
      overrideSystemTime(past.toISOString());

      Timestamp.send(hlc);

      expect(hlc.timestamp.millis()).toEqual(hlcTime);
      expect(hlc.timestamp.counter()).toEqual(hlcCounter + 1);
    });

    it(`throws an error if HLC's physical time is more recent than local time by more than allowed threshold`, () => {
      const now = Date.now();

      const hlc = makeClock(new Timestamp(now, 0, 'node1'));

      // Set local system time to be further in the past (relative to the HLC) than what is allowed
      const past = new Date(now - (HLC_CONFIG.maxDrift + 1));
      overrideSystemTime(past.toISOString());

      expect(() => {
        // The attempt to advance the passed-in clock's time should fail due to its time occuring _after_ the local
        // system's current time by a substantial amount (i.e., this simulates an oplog message from a system whose
        // clock is really out of whack--or possibly the local system's clock being really off).
        Timestamp.send(hlc);
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

  describe('recv()', () => {
    it('advances clock to system time if that is the most recent', () => {
      const systemTime = overrideSystemTime('2020-01-01T00:00:01Z');
      const ourHlc = makeClock(new Timestamp(systemTime - 1000, 0, 'ourNode'));
      const theirTimestamp = new Timestamp(systemTime - 2000, 0, 'theirNode');

      const ourNewTimestamp = Timestamp.recv(ourHlc, theirTimestamp);

      expect(ourNewTimestamp.millis()).toEqual(systemTime);
      expect(ourNewTimestamp.counter()).toEqual(0);
    });

    it(`re-uses HLC's phys time if that is the most recent, and increments counter`, () => {
      const systemTime = overrideSystemTime('2020-01-01T00:00:01Z');

      // Set the "external" timestamp to a time in the past.
      const theirTimestamp = new Timestamp(systemTime - 2000, 0, 'theirNode');

      // Set what will be our local HLC to a time slightly more recent than the system time
      const ourHlcInitialTime = systemTime + 1000;
      const ourHlcInitialCounter = 0;
      const ourHlc = makeClock(new Timestamp(ourHlcInitialTime, ourHlcInitialCounter, 'ourNode'));

      // Ask `recv()` to sync/update our HLC, expecting it to find `ourHlc` as having the most recent physical time, and
      // re-using that time (which means incrementing the counter).
      Timestamp.recv(ourHlc, theirTimestamp);

      expect(ourHlc.timestamp.millis()).toEqual(ourHlcInitialTime);
      expect(ourHlc.timestamp.counter()).toEqual(ourHlcInitialCounter + 1);
    });

    it(`re-uses passed-in timestamp's phys time if that is the most recent, and increments counter`, () => {
      const systemTime = overrideSystemTime('2020-01-01T00:00:01Z');

      // Set our HLC to to a time in the past.
      const ourHlc = makeClock(new Timestamp(systemTime - 2000, 0, 'ourNode'));

      // Set the incoming timestamp to a physical time slightly more recent than the system time
      const theirInitialPhysTime = systemTime + 1000;
      const theirInitialCounter = 0;
      const theirTimestamp = new Timestamp(theirInitialPhysTime, theirInitialCounter, 'theirNode');

      // Ask `recv()` to sync/update our HLC, expecting it to find `theirTimestamp` as having the most recent physical
      // time, and re-using that time (which means incrementing the counter).
      Timestamp.recv(ourHlc, theirTimestamp);

      expect(ourHlc.timestamp.millis()).toEqual(theirInitialPhysTime);
      expect(ourHlc.timestamp.counter()).toEqual(theirInitialCounter + 1);
    });

    it('increments the greatest counter if system, HLC, and incoming timestamp all have same phys. time', () => {
      const systemTime = overrideSystemTime('2020-01-01T00:00:01Z');

      const ourHlcCounter = 111;
      const ourHlc = makeClock(new Timestamp(systemTime, ourHlcCounter, 'ourNode'));

      const theirInitialCounter = 222;
      const theirTimestamp = new Timestamp(systemTime, theirInitialCounter, 'theirNode');

      Timestamp.recv(ourHlc, theirTimestamp);

      expect(ourHlc.timestamp.millis()).toEqual(systemTime);
      expect(ourHlc.timestamp.counter()).toEqual(theirInitialCounter + 1);
    });

    it('throws an error if the local clock and passed-in timestamp are associated with the same node', () => {
      // Create a local clock associated with a node ID
      const clock = makeClock(new Timestamp(Date.parse('2020-01-01T00:00:02Z'), 123, 'node1'));

      // Create a timestamp associated with the _same_ node ID
      const timestamp = new Timestamp(Date.now(), 1, clock.timestamp.node());

      // Verify that recv() throws an error when we ask it to advance the clock time using this timestamp. This is
      // desired behavior because if the timestamp has the same node ID, that implies we have _already_ processed
      // that event (and already adjusted our HLC time for that event).
      expect(() => {
        // The attempt to advance the passed-in clock's time should fail due to its time occuring _after_ the local
        // system's current time by a substantial amount (i.e., this simulates an oplog message from a system whose
        // clock is really out of whack--or possibly the local system's clock being really off).
        Timestamp.recv(clock, timestamp);
      }).toThrow(Timestamp.DuplicateNodeError);
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

      const timestamp = Timestamp.parse(`${expected.time}-${expected.counter}-${expected.node}`);

      expect(timestamp).toBeInstanceOf(Timestamp);
      expect(timestamp?.node()).toEqual(expected.node);
      expect(timestamp?.counter()).toEqual(expectedCounter);
    });

    it('returns null when given an invalid string', () => {
      expect(Timestamp.parse('')).toBeNull();
      expect(Timestamp.parse('asdfasdf')).toBeNull();

      // TODO: modify Timestamp.parse() to throw if it receives invalid dates (e.g., 2020-32-02), then add test for that
    });
  });

  it('hash() works', () => {
    const t1 = new Timestamp(Date.now(), 123, 'node1');
    const t2 = new Timestamp(Date.now() - 12345, 1, 'node2');
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

function overrideSystemTime(dateStr: string): number {
  const mockNowTime = new Date(dateStr).getTime();
  jest.useFakeTimers('modern');
  jest.setSystemTime(mockNowTime);
  return mockNowTime;
}
