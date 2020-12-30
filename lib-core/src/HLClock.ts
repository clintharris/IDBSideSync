import { HLTime } from './HLTime';

export class HLClock {
  private static _time: HLTime | null = null;

  // Maximum physical clock drift allowed, in ms. In other words, if we receive a message from another node and that
  // node's time differs from ours by more than this many milliseconds, throw an error.
  public static readonly maxDrift = 60000;

  // We don't support counters greater than 65535 because we need to ensure that, when converted to a hex string, it
  // doesn't use more than 4 chars (see Timestamp.toString). For example:
  //   (65533).toString(16) -> fffd
  //   (65534).toString(16) -> fffe
  //   (65535).toString(16) -> ffff
  //   (65536).toString(16) -> 10000 -- oops, this is 5 chars It's not that a larger counter couldn't be
  // used--that would just mean increasing the expected length of the counter part of the timestamp and updating the
  // code that parses/generates that string. Some sort of length needs to be picked, and therefore there is going to
  // be some sort of limit to how big the counter can be.
  public static readonly maxCounter = 65535;

  public static time(): HLTime {
    if (!HLClock._time) {
      throw new HLClock.TimeNotSetError();
    }
    return HLClock._time;
  }

  public static setTime(time: HLTime): void {
    HLClock._time = time;
  }

  public static serialize(): string {
    if (!HLClock._time) {
      throw new HLClock.TimeNotSetError();
    }
    return JSON.stringify({
      time: HLClock._time?.toString(),
    });
  }

  public static deserialize(json: string): void {
    const data = JSON.parse(json);
    const time = HLTime.parse(data.time);
    if (!time) {
      throw new HLClock.DeserializationError(`Invalid or missing time:'${data.time}'`);
    }
    HLClock._time = time;
  }

  /**
   * Use this function to advance the time of the passed-in hybrid logical clock (i.e., our local HLC clock singleton),
   * and return the next time as a new HLC timestamp.
   *
   * For context, this function should normally be called in cases when we are creating a new oplog entry as part of
   * local data changes (i.e., not in response to processing oplog entries received from another node). In other words,
   * whenever the local node initiates a CRUD operation, we need to create a new journal entry, which means we need to
   * create a new HLC timestamp for that entry--and that implies advancing the clock.
   */
  public static tick(): HLTime {
    if (!HLClock._time) {
      throw new HLClock.TimeNotSetError();
    }
    const systemTime = Date.now();
    const ourHlcTime = HLClock._time.millis();

    // If our local system clock has been ticking away correctly since the last time we updated our local HLC, then the
    // local HLC singleton's physical time should either be in the past, or _maybe_ "now" if we happened to _just_
    // update it. If the HLC's time is somehow ahead of ours, something could be off (e.g., perhaps our local system
    // clock is messed up).
    if (ourHlcTime - systemTime > HLClock.maxDrift) {
      const hlcTimeStr = new Date(ourHlcTime).toISOString();
      const sysTimeStr = new Date(systemTime).toISOString();
      throw new HLClock.ClockDriftError(
        `Local HLC's physical time (${hlcTimeStr}) is ahead of system time (${sysTimeStr}) by more than ` +
          `${HLClock.maxDrift} msec. Is system clock set correctly?`
      );
    }

    // Calculate the next physical time, ensuring that it only moves forward.
    const nextTime = Math.max(ourHlcTime, systemTime);

    // Determine the next counter value. The counter only needs to increment if the physical time did NOT change;
    // otherwise we can reset the counter to 0.
    const nextCount = ourHlcTime === nextTime ? HLClock._time.counter() + 1 : 0;

    if (nextCount > HLClock.maxCounter) {
      throw new HLClock.OverflowError();
    }

    // Update the HLC.
    HLClock._time = new HLTime(nextTime, nextCount, HLClock._time.node());

    return HLClock._time;
  }

  /**
   * Use this function to advance the time of the passed-in hybrid logical clock (i.e., our local HLC clock singleton),
   * such that the next time occurs _after_ both that of the local HLC _and_ the passed-in HLC timestamp.
   *
   * This function will always update the passed-in HLC to the most recent physical time that we know about (i.e., given
   * the local system time, local HLC, and passed-in timestamp, pick the the most recent physical time.
   *
   * If our local HLC or the passed-in timestamp has a physical time more recent than our local system (CPU) time, one
   * of those physical times will be used as the new "current" HLC physical time. In that case, however, the physical
   * time hasn't actually changed (e.g., if the passed-in timestamp has the most recent phys. time, we'll reuse it) so
   * we would have to increment the HLC's counter to ensure that the logical time is moved forward.
   *
   * Normally, this function should only be called when we are receiving oplog entries from other nodes. In that
   * scenario the goal is to ensure that the local node's HLC is always set to a time that occurs _after_ all HLC event
   * times we have encountered. In other words, we are "syncing" our clock with the other nodes in the distributed
   * system (since, conceptually, they are all trying to "share" an HLC and can advance that clock's time--for
   * everyone--whenever a new event is recorded).
   *
   * So whenever we counter an event that was published from some other node, we need to update our own HLC so that it
   * is set to a time that occurs _after_ all previous "clock ticks" made by other nodes. This way, if we create a new
   * oplog entry recording some new data change, we can trust that the timestamp for that event occurs after all the
   * other events we know about. In effect, this is how all the data change messages/events can be consistently ordered
   * across the distributed system.
   *
   * Note: at some point this function's logic might be integrated into to the `send()` function (e.g., with the second
   * "external timestamp" arg being optioanl).
   */
  public static tickPast(theirTimestamp: HLTime): HLTime {
    if (!HLClock._time) {
      throw new HLClock.TimeNotSetError();
    }
    const systemTime = Date.now();

    const ourHlcTime = HLClock._time.millis();
    const ourCounter = HLClock._time.counter();

    const theirHlcTime = theirTimestamp.millis();
    const theirCounter = theirTimestamp.counter();

    // We only expect this function to be called with `theirTimestamp` values whose node ID is different from ours
    // (i.e., as part of processing oplog entries from _other_ nodes). With that in mind, we expect all nodes to have
    // unique IDs; encountering one that matches ours is an error.
    if (theirTimestamp.node() === HLClock._time.node()) {
      throw new HLClock.DuplicateNodeError(HLClock._time.node());
    }

    // Check to see if the physical time associated with another node's event is more recent that our _current_ system
    // time. If we encounter this, it's a sign that a device's clock is probably set incorrectly (i.e., how could an
    // event that was already created have happened at a time "in the future"?).
    //
    // Similarly, we need to make sure that our own system time hasn't "drifted" to occur _before_ our local HLC's
    // physical time by too much (i.e., "system now" should normally be more recent than our HLC's last event time).
    //
    // Jared Forsyth provides one example of how "event times from the future" could cause problems: "[Imagine] if a
    // user has two devices, both offline, but device A is somehow an hour ahead of device B. The user makes a change on
    // device A, then walks over to device B and makes a conflicting change, logically thinking that the change on B
    // will win, because it is 'last'. Once both devices come online, the change from device A has won, much to the
    // user's surprise" (from https://jaredforsyth.com/posts/hybrid-logical-clocks/).
    if (theirHlcTime - systemTime > HLClock.maxDrift) {
      // One option for handling this scenario might be to prompt the user to verify that their device's time is set
      // correctly and re-attempt the sync later, or ignore the other node's event (possibly ignoring all events from
      // the other node that also have "future" timestamps).
      throw new HLClock.ClockDriftError(
        `Encountered an event/message from another node (${theirTimestamp.node()}) with time '${theirTimestamp}' ` +
          `occuring "in the future" compared to local system time (${new Date(systemTime).toISOString()}).`
      );
    } else if (ourHlcTime - systemTime > HLClock.maxDrift) {
      const hlcTimeStr = new Date(ourHlcTime).toISOString();
      const sysTimeStr = new Date(systemTime).toISOString();
      throw new HLClock.ClockDriftError(
        `Local HLC's physical time (${hlcTimeStr}) is ahead of system time (${sysTimeStr}) by more than ` +
          `${HLClock.maxDrift} msec. Is local system clock set correctly?`
      );
    }

    // Given our HLC time, the incoming timestamp's time, and the current system time, pick whichever is most recent. If
    // our local device time is older than either of these, it means we'll end up _re-using_ a physical time from either
    // our HLC or the passed-in timestamp (i.e., we didn't move time forward)--so we'll have to make sure to increment
    // the counter.
    const nextTime = Math.max(Math.max(ourHlcTime, systemTime), theirHlcTime);

    // By default, assume the physical time is changing (i.e., that the counter will "reset" to zero).
    let nextCounter = 0;

    // Now check to see if the physical time didn't actually change (in which case we need to increment thee counter).
    if (nextTime === ourHlcTime && nextTime === theirHlcTime) {
      // The next physical time that will be used isn't changing--it's the same as both our local HLC's phyiscal time
      // _and_ the incoming HLC's physical time. In that scenario it's important to increment the "logical" part of the
      // time--the counter--to ensure that time moves forward. Note that we are incrementing the greater of the existing
      // counters to make sure the next counter differs.
      nextCounter = Math.max(ourCounter, theirCounter) + 1;
    } else if (nextTime === ourHlcTime) {
      // The next physical time that will be used isn't changing--it's the same as our local HLC's physical time--so we
      // need to increment the counter in a way that ensures it differs from the rest of our local HLC (which is why we
      // are incrementing _that_ counter).
      nextCounter = ourCounter + 1;
    } else if (nextTime === theirHlcTime) {
      // The next physical time that will be used isn't changing--it's the same as the incoming HLC's time--so we need
      // to increment the counter in a way that ensures it differs from the rest of the incoming HLC (which is why we
      // are incrementing _that_ counter).
      nextCounter = theirCounter + 1;
    }

    if (nextCounter > HLClock.maxCounter) {
      throw new HLClock.OverflowError();
    }

    // Update our HLC.
    HLClock._time = new HLTime(nextTime, nextCounter, HLClock._time.node());

    return HLClock._time;
  }

  static DeserializationError = class DeserializationError extends Error {
    constructor(message: string) {
      super(message);
      Object.setPrototypeOf(this, DeserializationError.prototype); // https://preview.tinyurl.com/y4jhzjgs
    }
  };

  static TimeNotSetError = class TimeNotSetError extends Error {
    constructor() {
      super('Clock time has not been set.');
      Object.setPrototypeOf(this, TimeNotSetError.prototype); // https://preview.tinyurl.com/y4jhzjgs
    }
  };

  static ClockDriftError = class ClockDriftError extends Error {
    constructor(message: unknown) {
      super(JSON.stringify(message));
      Object.setPrototypeOf(this, ClockDriftError.prototype); // https://preview.tinyurl.com/y4jhzjgs
    }
  };

  static OverflowError = class OverflowError extends Error {
    constructor() {
      super('timestamp counter overflow');
      Object.setPrototypeOf(this, OverflowError.prototype); // https://preview.tinyurl.com/y4jhzjgs
    }
  };

  static DuplicateNodeError = class DuplicateNodeError extends Error {
    constructor(node: unknown) {
      super('duplicate node identifier ' + JSON.stringify(node));
      Object.setPrototypeOf(this, DuplicateNodeError.prototype); // https://preview.tinyurl.com/y4jhzjgs
    }
  };
}
