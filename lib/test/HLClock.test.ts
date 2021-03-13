import { expect, jest, describe, it } from '@jest/globals';

import { HLClock } from '../src/HLClock';
import { HLTime } from '../src/HLTime';

describe('HLClock', () => {
  it('time() and set() work.', () => {
    const expectedTime = new HLTime(1, 2, 'foo');
    HLClock.setTime(expectedTime);
    expect(HLClock.time()).toEqual(expectedTime);
  });

  it('serialize() returns expected value.', () => {
    const millis = 1;
    const counter = 2;
    const clientId = 'foo';
    HLClock.setTime(new HLTime(millis, counter, clientId));
    const expectedJson = `{"time":"1970-01-01T00:00:00.00${millis}Z_000${counter}_0000000000000${clientId}"}`;
    const actualJson = HLClock.serialize();
    expect(actualJson).toEqual(expectedJson);
  });

  describe('tick()', () => {
    it('advances clock time to "now" if its physical time occurs before "now"', () => {
      const mockNowTime = overrideSystemTime('2020-01-01T00:00:01Z');

      HLClock.setTime(new HLTime(Date.parse('04 Dec 1995 00:12:00 GMT'), 123, 'node1'));
      const actualTime = HLClock.tick();

      // The clock should have been advanced and the counter reset to 0
      expect(actualTime.millis()).toEqual(mockNowTime);
      expect(actualTime.counter()).toEqual(0);
    });

    it('increments clock counter if its physical time is "now"', () => {
      const mockNowTime = overrideSystemTime('2020-01-01T00:00:01Z');
      const counter = 123;

      HLClock.setTime(new HLTime(mockNowTime, counter, 'node1'));
      const actualTime = HLClock.tick();

      expect(actualTime.millis()).toEqual(mockNowTime);
      expect(actualTime.counter()).toEqual(counter + 1);
    });

    it(`advances clock time to HLC's time if it is more recent, within allowed threshold`, () => {
      const hlcTime = Date.now();
      const hlcCounter = 0;

      HLClock.setTime(new HLTime(hlcTime, hlcCounter, 'node1'));

      // Set local system time to be in the past (relative to the HLC), but not _too far_ in the past...
      const past = new Date(hlcTime - HLClock.maxDrift);
      overrideSystemTime(past.toISOString());

      const actualTime = HLClock.tick();

      expect(actualTime.millis()).toEqual(hlcTime);
      expect(actualTime.counter()).toEqual(hlcCounter + 1);
    });

    it(`throws an error if HLC's physical time is more recent than local time by more than allowed threshold`, () => {
      const now = Date.now();

      HLClock.setTime(new HLTime(now, 0, 'node1'));

      // Set local system time to be further in the past (relative to the HLC) than what is allowed
      const past = new Date(now - (HLClock.maxDrift + 1));
      overrideSystemTime(past.toISOString());

      expect(() => {
        // The attempt to advance the passed-in clock's time should fail due to its time occuring _after_ the local
        // system's current time by a substantial amount (i.e., this simulates an oplog message from a system whose
        // clock is really out of whack--or possibly the local system's clock being really off).
        HLClock.tick();
      }).toThrow(HLClock.ClockDriftError);
    });

    it(`throws an error once counter value exceeds threshold`, () => {
      // "Freeze" local system time. We need to do this so that each time Timestamp.send() is called, it sees "now"
      // as being the same time as that of the HLC clock instance we're passing in. Only then, if the passed-in clock
      // and the system clock have the same times, will it "resort" to incrementing the counter (which is what we are
      // testing here).
      const mockNowTime = overrideSystemTime('2020-01-01T00:00:01Z');

      // Timer doesn't support count values greater than 65535 because it needs to ensure that, when the count is
      // converted to a hex string, it doesn't use more than 4 chars (see Timestamp.toString).
      const counterThreshold = HLClock.maxCounter;
      const initialCounterValue = counterThreshold - 10;

      HLClock.setTime(new HLTime(Date.now(), initialCounterValue, 'node1'));
      for (let i = initialCounterValue; i < counterThreshold; i++) {
        const actualTime = HLClock.tick();
        expect(actualTime.millis()).toEqual(mockNowTime);
        expect(actualTime.counter()).toEqual(i + 1);
      }

      // At this point, the HLC clock instance's counter should be just under the threshold. Calling Timestamp.send()
      // and attempting to advance the time (i.e., increment the counter) should push the counter over the limit and
      // cause an error to be thrown.
      expect(() => {
        // The attempt to advance the passed-in clock's time should fail due to its time occuring _after_ the local
        // system's current time by a substantial amount (i.e., this simulates an oplog message from a system whose
        // clock is really out of whack--or possibly the local system's clock being really off).
        HLClock.tick();
      }).toThrow(HLClock.OverflowError);
    });
  });

  describe('tickPast()', () => {
    it('advances clock to system time if that is the most recent', () => {
      const systemTime = overrideSystemTime('2020-01-01T00:00:01Z');
      HLClock.setTime(new HLTime(systemTime - 1000, 0, 'ourNode'));
      const theirTime = new HLTime(systemTime - 2000, 0, 'theirNode');

      const ourNewTime = HLClock.tickPast(theirTime);

      expect(ourNewTime.millis()).toEqual(systemTime);
      expect(ourNewTime.counter()).toEqual(0);
    });

    it(`re-uses HLC's phys time if that is the most recent, and increments counter`, () => {
      const systemTime = overrideSystemTime('2020-01-01T00:00:01Z');

      // Set the "external" timestamp to a time in the past.
      const theirTimestamp = new HLTime(systemTime - 2000, 0, 'theirNode');

      // Set what will be our local HLC to a time slightly more recent than the system time
      const ourHlcInitialTime = systemTime + 1000;
      const ourHlcInitialCounter = 0;
      HLClock.setTime(new HLTime(ourHlcInitialTime, ourHlcInitialCounter, 'ourNode'));

      // Ask `recv()` to sync/update our HLC, expecting it to find `ourHlc` as having the most recent physical time, and
      // re-using that time (which means incrementing the counter).
      const time = HLClock.tickPast(theirTimestamp);

      expect(time.millis()).toEqual(ourHlcInitialTime);
      expect(time.counter()).toEqual(ourHlcInitialCounter + 1);
    });

    it(`re-uses passed-in timestamp's phys time if that is the most recent, and increments counter`, () => {
      const systemTime = overrideSystemTime('2020-01-01T00:00:01Z');

      // Set our HLC to to a time in the past.
      HLClock.setTime(new HLTime(systemTime - 2000, 0, 'ourNode'));

      // Set the incoming timestamp to a physical time slightly more recent than the system time
      const theirInitialPhysTime = systemTime + 1000;
      const theirInitialCounter = 0;
      const theirTimestamp = new HLTime(theirInitialPhysTime, theirInitialCounter, 'theirNode');

      // Ask `recv()` to sync/update our HLC, expecting it to find `theirTimestamp` as having the most recent physical
      // time, and re-using that time (which means incrementing the counter).
      const time = HLClock.tickPast(theirTimestamp);

      expect(time.millis()).toEqual(theirInitialPhysTime);
      expect(time.counter()).toEqual(theirInitialCounter + 1);
    });

    it('increments the greatest counter if system, HLC, and incoming timestamp all have same phys. time', () => {
      const systemTime = overrideSystemTime('2020-01-01T00:00:01Z');

      const ourHlcCounter = 111;
      HLClock.setTime(new HLTime(systemTime, ourHlcCounter, 'ourNode'));

      const theirInitialCounter = 222;
      const theirTimestamp = new HLTime(systemTime, theirInitialCounter, 'theirNode');

      const time = HLClock.tickPast(theirTimestamp);

      expect(time.millis()).toEqual(systemTime);
      expect(time.counter()).toEqual(theirInitialCounter + 1);
    });
  });
});

function overrideSystemTime(dateStr: string): number {
  const mockNowTime = new Date(dateStr).getTime();
  jest.useFakeTimers('modern');
  jest.setSystemTime(mockNowTime);
  return mockNowTime;
}
