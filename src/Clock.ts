import { v4 as uuid } from 'uuid';
import { MutableTimestamp, Timestamp } from './Timestamp';

export interface IClock {
  timestamp: MutableTimestamp;
  merkle: any;
}

// TODO: Consider making `_clock` (and the following functions) "var static" members of a Clock class.

let _clock: IClock | null = null;

export function setClock(clock: IClock) {
  _clock = clock;
}

export function getClock() {
  return _clock;
}

export function makeClock(timestamp: Timestamp, merkle = {}): IClock {
  return { timestamp: MutableTimestamp.from(timestamp), merkle };
}

export function serializeClock(clock: IClock): string {
  return JSON.stringify({
    timestamp: clock.timestamp.toString(),
    merkle: clock.merkle,
  });
}

function deserializeClock(clock: string): IClock {
  const data = JSON.parse(clock);
  const timestamp = Timestamp.parse(data.timestamp);
  if (!timestamp) {
    throw new ClockDeserializationError(`Invalid or missing timestamp:'${data.timestamp}'`);
  }
  return {
    timestamp: MutableTimestamp.from(timestamp),
    merkle: data.merkle,
  };
}

/**
 * Use this function to create a presumably unique string that can be used to identify a client/node/agent. This just
 * uses the last 16 chars of a UUID (e.g., `37c2877f-fbf4-40f3-bdb7-87f4536dc989` => `bdb787f4536dc989`);
 *
 * @returns {string} a 16-char, presumably unique string.
 */
export function makeClientId(): string {
  return uuid()
    .replace(/-/g, '')
    .slice(-16); // TODO: Figure out if there's a reason for using last 16 chars, specifically.
}

class ClockDeserializationError extends Error {
  public type: string;

  constructor(message: string) {
    super();
    this.type = 'ClockDeserializationError';
    this.message = message;
  }
}
