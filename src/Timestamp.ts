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
   * This function is called whenever a record is being inserted, updated, or deleted in the data store. These are all
   * events that need to be recorded in the operation log / journal, and need their own HLC timestamps so that they can
   * be consistently ordered/sorted on any client.
   *
   * Note: at some point this function might be moved to the `Clock` and renamed `next()` to more clearly indicate that
   * it is really just advancing the local HLC and returning the resulting, next HLC time.
   */
  public static send(clock: IClock): Timestamp {
    const now = Date.now();
    const hlcTime = clock.timestamp.millis();

    // If our local system clock has been ticking away correctly since the last time we updated our local HLC, then the
    // local HLC singleton's physical time should either be in the past, or _maybe_ "now" if we happened to _just_
    // update it. If the HLC's time is somehow ahead of ours, something could be off (e.g., perhaps our local system
    // clock is messed up).
    if (hlcTime - now > HLC_CONFIG.maxDrift) {
      throw new Timestamp.ClockDriftError(
        `Local HLC singleton's physical time is somehow in the future compared to local system time. Is the local ` +
          `system's clock set correctly?`
      );
    }

    // Calculate the next physical time, ensuring that it only moves forward.
    const nextTime = Math.max(hlcTime, now);

    // Determine the next counter value. The counter only needs to increment if the physical time did NOT change;
    // otherwise we can reset the counter to 0.
    const nextCount = hlcTime === nextTime ? clock.timestamp.counter() + 1 : 0;

    if (nextCount > HLC_CONFIG.maxCounter) {
      throw new Timestamp.OverflowError();
    }

    // Update the HLC.
    clock.timestamp.setMillis(nextTime);
    clock.timestamp.setCounter(nextCount);

    return new Timestamp(clock.timestamp.millis(), clock.timestamp.counter(), clock.timestamp.node());
  }

  // Timestamp receive. Parses and merges a timestamp from a remote system with the local timeglobal uniqueness and
  // monotonicity are preserved
  public static recv(clock: IClock, msg: Timestamp) {
    var phys = Date.now();

    // Unpack the message wall time/counter
    var lMsg = msg.millis();
    var cMsg = msg.counter();

    // Assert the node id and remote clock drift
    if (msg.node() === clock.timestamp.node()) {
      // Whoops, looks like the message came from the same node ID as ours!
      throw new Timestamp.DuplicateNodeError(clock.timestamp.node());
    }

    if (lMsg - phys > HLC_CONFIG.maxDrift) {
      // Whoops, the other node's physical time differs from ours by more than
      // the configured limit (e.g., 1 minute).
      throw new Timestamp.ClockDriftError();
    }

    // Unpack the clock.timestamp logical time and counter
    var lOld = clock.timestamp.millis();
    var cOld = clock.timestamp.counter();

    // Calculate the next logical time and counter.
    // Ensure that the logical time never goes backward;
    // * if all logical clocks are equal, increment the max counter,
    // * if max = old > message, increment local counter,
    // * if max = messsage > old, increment message counter,
    // * otherwise, clocks are monotonic, reset counter
    var lNew = Math.max(Math.max(lOld, phys), lMsg);
    var cNew =
      lNew === lOld && lNew === lMsg
        ? Math.max(cOld, cMsg) + 1
        : lNew === lOld
        ? cOld + 1
        : lNew === lMsg
        ? cMsg + 1
        : 0;

    // Check the result for drift and counter overflow
    if (lNew - phys > HLC_CONFIG.maxDrift) {
      throw new Timestamp.ClockDriftError();
    }
    if (cNew > HLC_CONFIG.maxCounter) {
      throw new Timestamp.OverflowError();
    }

    // Repack the logical time/counter
    clock.timestamp.setMillis(lNew);
    clock.timestamp.setCounter(cNew);

    return new Timestamp(clock.timestamp.millis(), clock.timestamp.counter(), clock.timestamp.node());
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
