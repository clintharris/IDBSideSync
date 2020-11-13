import murmurhash from 'murmurhash';
import { IClock } from './Clock';

// (function(root, factory) {
//   if (typeof exports === 'object') {
//     module.exports = factory(require('murmurhash'));
//   } else {
//     let { Timestamp, MutableTimestamp } = factory(root.murmur);
//     root.Timestamp = Timestamp;
//     root.MutableTimestamp = MutableTimestamp;
//   }
// })(this, function(murmurhash) {

interface IOptions {
  maxCounter: number;
  maxDrift: number;
}

export const HLC_CONFIG: IOptions = {
  // We don't support counters greater than 65535 because we need to ensure that, when converted to a hex string, it
  // doesn't use more than 4 chars (see Timestamp.toString). For example:
  //   (65533).toString(16) -> fffd
  //   (65534).toString(16) -> fffe
  //   (65535).toString(16) -> ffff
  //   (65536).toString(16) -> 10000 -- oops, this is 5 chars It's not that a larger counter couldn't be
  // used--that would just mean increasing the expected length of the counter part of the timestamp and updating the
  // code that parses/generates that string. Some sort of length needs to be picked, and therefore there is going to
  // be some sort of limit to how big the counter can be.
  maxCounter: 65535,

  // Maximum physical clock drift allowed, in ms. In other words, if we receive a message from another node and that
  // node's time differs from ours by more than this many milliseconds, throw an error.
  maxDrift: 60000,
};

/**
 * This class is used to model immutable instances of time as measured by a Hybrid Logical Clock, which combines both a
 * "physical" clock time and a "logical" monotonic counter.
 */
export class Timestamp {
  // Timestamp generator initialization
  // * sets the node ID to an arbitrary value
  // * useful for mocking/unit testing
  public static init(options: { maxDrift?: number } = {}) {
    if (options.maxDrift) {
      HLC_CONFIG.maxDrift = options.maxDrift;
    }
  }

  /**
   * Use this function to advance the time of the passed-in hybrid logical clock (i.e., our local HLC clock singleton),
   * and return that time as a new HLC timestamp.
   *
   * For context, this function should normally be called in cases when we are creating a new oplog entry as part of
   * local data changes (i.e., not in response to processing oplog entries received from another node). In other words,
   * whenever the local node initiates a CRUD operation, we need to create a new journal entry, which means we need to
   * create a new HLC timestamp for that entry--and that implies advancing the clock.
   *
   * Note: at some point this function might be moved to the `Clock` and renamed `next()` (or `tick()`) to more clearly
   * indicate that it is really just advancing the local HLC and returning the resulting time.
   */
  public static send(clock: IClock): Timestamp {
    const systemTime = Date.now();
    const ourHlcTime = clock.timestamp.millis();

    // If our local system clock has been ticking away correctly since the last time we updated our local HLC, then the
    // local HLC singleton's physical time should either be in the past, or _maybe_ "now" if we happened to _just_
    // update it. If the HLC's time is somehow ahead of ours, something could be off (e.g., perhaps our local system
    // clock is messed up).
    if (ourHlcTime - systemTime > HLC_CONFIG.maxDrift) {
      const hlcTimeStr = new Date(ourHlcTime).toISOString();
      const sysTimeStr = new Date(systemTime).toISOString();
      throw new Timestamp.ClockDriftError(
        `Local HLC's physical time (${hlcTimeStr}) is ahead of system time (${sysTimeStr}) by more than ` +
          `${HLC_CONFIG.maxDrift} msec. Is system clock set correctly?`
      );
    }

    // Calculate the next physical time, ensuring that it only moves forward.
    const nextTime = Math.max(ourHlcTime, systemTime);

    // Determine the next counter value. The counter only needs to increment if the physical time did NOT change;
    // otherwise we can reset the counter to 0.
    const nextCount = ourHlcTime === nextTime ? clock.timestamp.counter() + 1 : 0;

    if (nextCount > HLC_CONFIG.maxCounter) {
      throw new Timestamp.OverflowError();
    }

    // Update the HLC.
    clock.timestamp.setMillis(nextTime);
    clock.timestamp.setCounter(nextCount);

    return new Timestamp(clock.timestamp.millis(), clock.timestamp.counter(), clock.timestamp.node());
  }

  /**
   * Use this function to advance the time of the passed-in hybrid logical clock (i.e., our local HLC clock singleton),
   * such that the next time occurs _after_ that of the passed-in HLC timestamp, and return that next HLC time.
   *
   * This function will always update the passed-in HLC (i.e., our local node's HLC) to the most recent physical time
   * that we know about, meaning: whichever of the local system time, local HLC, and passed-in timestamp has the most
   * recent physical time.
   *
   * If, for some reason, our local HLC or the passed-in timestamp has a physical time more recent than our local system
   * (CPU) time, one of those physical times will be used as the new "current" HLC physical time. In that case, however,
   * the physical time hasn't actually changed (i.e., our HLC has the same physical time as an existing event) so we
   * have to increment the HLC's counter to ensure that the logical time is moved forward.
   *
   * Normally, this function should only be called when we are processing oplog entries from other nodes. In that
   * scenario, out goal is to ensure that the local node's HLC is always set to a time that occurs _after_ all HLC event
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
  public static recv(ourClock: IClock, theirTimestamp: Timestamp): Timestamp {
    const systemTime = Date.now();

    const ourHlcTime = ourClock.timestamp.millis();
    const ourCounter = ourClock.timestamp.counter();

    const theirHlcTime = theirTimestamp.millis();
    const theirCounter = theirTimestamp.counter();

    // We only expect this function to be called with `theirTimestamp` values whose node ID is different from ours
    // (i.e., as part of processing oplog entries from _other_ nodes). With that in mind, we expect all nodes to have
    // unique IDs; encountering one that matches ours is an error.
    if (theirTimestamp.node() === ourClock.timestamp.node()) {
      throw new Timestamp.DuplicateNodeError(ourClock.timestamp.node());
    }

    // TODO: consider increasing the allowed difference for clock times coming from other systems; only allowing for
    // a 1-minute difference between any other clock in the distributed system seems like it could be error prone...
    if (theirHlcTime - systemTime > HLC_CONFIG.maxDrift) {
      throw new Timestamp.ClockDriftError();
    }

    // Given our HLC time, the incoming timestamp's time, and the current system time, pick whichever is most recent. If
    // our local system (CPU) time is older than either of these, it means we'll end up _re-using_ a physical time from
    // either our HLC or the passed-in timestamp (i.e., we didn't move time forward)--so we'll have to make sure to
    // increment the counter.
    const nextTime = Math.max(Math.max(ourHlcTime, systemTime), theirHlcTime);

    // Check the result for drift and counter overflow
    if (nextTime - systemTime > HLC_CONFIG.maxDrift) {
      throw new Timestamp.ClockDriftError();
    }

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
      // The next physical time that will be used isn't changing--it's the same as our local HLC's physical time--so we need
      // to increment the counter in a way that ensures it differs from the rest of our local HLC (which is why we are
      // incrementing _that_ counter).
      nextCounter = ourCounter + 1;
    } else if (nextTime === theirHlcTime) {
      // The next physical time that will be used isn't changing--it's the same as the incoming HLC's time--so we need
      // to increment the counter in a way that ensures it differs from the rest of the incoming HLC (which is why we
      // are incrementing _that_ counter).
      nextCounter = theirCounter + 1;
    }

    if (nextCounter > HLC_CONFIG.maxCounter) {
      throw new Timestamp.OverflowError();
    }

    // Update our HLC.
    ourClock.timestamp.setMillis(nextTime);
    ourClock.timestamp.setCounter(nextCounter);

    return new Timestamp(ourClock.timestamp.millis(), ourClock.timestamp.counter(), ourClock.timestamp.node());
  }

  /**
   * Converts a fixed-length string timestamp to the structured value
   */
  public static parse(timestamp: string): Timestamp | null {
    if (typeof timestamp === 'string') {
      var parts = timestamp.split('-');
      if (parts && parts.length === 5) {
        var millis = Date.parse(parts.slice(0, 3).join('-')).valueOf();
        var counter = parseInt(parts[3], 16);
        var node = parts[4];
        if (!isNaN(millis) && !isNaN(counter)) return new Timestamp(millis, counter, node);
      }
    }
    return null;
  }

  public static since(isoString: string) {
    return isoString + '-0000-0000000000000000';
  }

  static DuplicateNodeError = class extends Error {
    public type: string;
    public message: string;

    constructor(node: string) {
      super();
      this.type = 'DuplicateNodeError';
      this.message = 'duplicate node identifier ' + node;
    }
  };

  static ClockDriftError = class extends Error {
    public type: string;

    constructor(...args: string[]) {
      super();
      this.type = 'ClockDriftError';
      this.message = ['maximum clock drift exceeded'].concat(args).join(' ');
    }
  };

  static OverflowError = class extends Error {
    public type: string;
    constructor() {
      super();
      this.type = 'OverflowError';
      this.message = 'timestamp counter overflow';
    }
  };

  protected _state: {
    millis: number;
    counter: number;
    node: string;
  };

  /**
   *
   * @param millis - human-friendly "physical clock time" part of the hybrid logical clock (usually msecs since 1970)
   * @param counter - the monotonic counter part of the hybrid logical clock.
   * @param node - identifies the client, or node, that created the timestamp.
   */
  constructor(millis: number, counter: number, node: string) {
    this._state = {
      millis: millis,
      counter: counter,
      node: node,
    };
  }

  /**
   * Override the standard valueOf() inherited from the Object prototype, allowing instances of this class to to eval
   * to this primitive value when used in expressions. (For more info see
   * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/valueOf.)
   */
  valueOf(): string {
    return this.toString();
  }

  /**
   * Override the standard toString() inherited from the Object prototype. The stringified timestamp is FIXED LENGTH in
   * the format `<date/time>-<counter>-<client ID>`, where:
   *
   *   - `<date/time>` is ISO 8601 date string via `Date.toISOString()`
   *   - `<counter>` is a hexadecimal encoded version of the counter, always 4 chars in length
   *     - ensuring that we never have more that 4 chars means there is a limit to how big the counter can be: 65535.
   *     - (65533).toString(16) -> fffd (4 chars)
   *     - (65534).toString(16) -> fffe
   *     - (65535).toString(16) -> ffff
   *     - (65536).toString(16) -> 10000 -- oops, this is 5 chars
   *   - `<client ID>` is the last 16 chars of a UUID (with hyphen removed):
   *       - UUID: `xxxxxxxx-xxxx-xxxx-bdb7-87f4536dc989`, client/node: `bdb787f4536dc989`
   *
   * Examples:
   *
   *   - `2020-02-02T16:29:22.946Z-0000-97bf28e64e4128b0` (millis = 1580660962946, counter = 0, node = 97bf28e64e4128b0)
   *   - `2020-02-02T16:30:12.281Z-0001-bc5fd821dc0e3653` (millis = 1580661012281, counter = 1, node = bc5fd821dc0e3653)
   *     - Note that `<ISO 8601 date string>` is via `Date.toISOString()`
   */
  toString(): string {
    // Convert msec timestamp to GMT string
    return [
      new Date(this.millis()).toISOString(),
      ('0000' + this.counter().toString(16).toUpperCase()).slice(-4),
      ('0000000000000000' + this.node()).slice(-16),
    ].join('-');
  }

  millis() {
    return this._state.millis;
  }

  counter() {
    return this._state.counter;
  }

  node() {
    return this._state.node;
  }

  hash() {
    return murmurhash.v3(this.toString());
  }
}

/**
 * Used to manage _mutable_ instances of HLC time.
 */
export class MutableTimestamp extends Timestamp {
  public static from(timestamp: Timestamp): MutableTimestamp {
    // Invoking the `MutableTimestamp` constructor function, which we haven't actually defined anywhere, will result in
    // the parent class constructor being called instead (i.e., this is the same as calling `Timestamp(...)`).
    return new MutableTimestamp(timestamp.millis(), timestamp.counter(), timestamp.node());
  }

  setMillis(n: number) {
    this._state.millis = n;
  }

  setCounter(n: number) {
    this._state.counter = n;
  }

  setNode(n: string) {
    this._state.node = n;
  }
}
