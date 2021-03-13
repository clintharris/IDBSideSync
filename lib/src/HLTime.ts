import murmurhash from 'murmurhash';

/**
 * This class is used to model immutable instances of time as measured by a Hybrid Logical Clock, which combines both a
 * "physical" clock time and a "logical" monotonic counter.
 */
export class HLTime {
  public static readonly STRING_PARTS_DELIMITER = '_';
  public static readonly COUNTER_PART_STR_LENGTH = 4;
  public static readonly NODE_PART_STR_LENGTH = 16;

  /**
   * Converts an HLC time string to a HLTime instance.
   */
  public static parse(timestamp: string): HLTime {
    if (typeof timestamp !== 'string') {
      throw new HLTime.ParseError(timestamp, 'not a string');
    }

    const parts = timestamp.split(HLTime.STRING_PARTS_DELIMITER);
    if (parts.length !== 3) {
      throw new HLTime.ParseError(timestamp, 'not in format <date>_<counter>_<node>');
    }

    const millis = Date.parse(parts[0]).valueOf();
    const counter = parseInt(parts[1], 16);
    const node = parts[2];

    if (isNaN(millis)) {
      throw new HLTime.ParseError(timestamp, 'unable to parse date/time string to date');
    } else if (isNaN(counter)) {
      throw new HLTime.ParseError(timestamp, 'failed to parse counter to number');
    } else if (node.length !== HLTime.NODE_PART_STR_LENGTH) {
      throw new HLTime.ParseError(timestamp, `node ID should have ${HLTime.NODE_PART_STR_LENGTH} characters`);
    }

    return new HLTime(millis, counter, node);
  }

  protected _state: {
    millis: number;
    counter: number;
    node: string;
  };

  /**
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
   * the format `<date/time>_<counter>_<client ID>`, where:
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
   *   - `2020-02-02T16:29:22.946Z_0000_97bf28e64e4128b0` (millis = 1580660962946, counter = 0, node = 97bf28e64e4128b0)
   *   - `2020-02-02T16:30:12.281Z_0001_bc5fd821dc0e3653` (millis = 1580661012281, counter = 1, node = bc5fd821dc0e3653)
   *     - Note that `<ISO 8601 date string>` is via `Date.toISOString()`
   */
  toString(): string {
    // Convert msec timestamp to GMT string
    return [
      new Date(this.millis()).toISOString(),
      (
        '0'.repeat(HLTime.COUNTER_PART_STR_LENGTH) +
        this.counter()
          .toString(16)
          .toUpperCase()
      ).slice(-HLTime.COUNTER_PART_STR_LENGTH),
      ('0'.repeat(HLTime.NODE_PART_STR_LENGTH) + this.node()).slice(-HLTime.NODE_PART_STR_LENGTH),
    ].join(HLTime.STRING_PARTS_DELIMITER);
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

  static ParseError = class ParseError extends Error {
    // Constructor param must be of type `unknown` to avoid TypeScript/Jest error: https://git.io/JqCDN
    constructor(invalidTimestampStr: unknown, reason: string) {
      super(`Invalid HLTime string; ${reason}: ` + JSON.stringify(invalidTimestampStr));
      Object.setPrototypeOf(this, ParseError.prototype); // https://git.io/vHLlu
    }
  };
}

/**
 * Used to manage _mutable_ instances of HLC time.
 */
export class HLMutableTime extends HLTime {
  public static from(timestamp: HLTime): HLMutableTime {
    // Invoking the `MutableTimestamp` constructor function, which we haven't actually defined anywhere, will result in
    // the parent class constructor being called instead (i.e., this is the same as calling `Timestamp(...)`).
    return new HLMutableTime(timestamp.millis(), timestamp.counter(), timestamp.node());
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
