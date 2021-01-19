import { v4 as uuid } from 'uuid';
import { HLTime } from './HLTime';

export { v4 as uuid } from 'uuid';

/**
 * Use this function to create a presumably unique string that can be used to identify a client/node/agent. This just
 * uses the last 16 chars of a UUID (e.g., `37c2877f-fbf4-40f3-bdb7-87f4536dc989` => `bdb787f4536dc989`);
 *
 * @returns a 16-char, presumably-unique string.
 */
export function makeNodeId(): string {
  return uuid()
    .replace(/-/g, '')
    .slice(-16); // TODO: Figure out if there's a reason for using last 16 chars, specifically.
}

/**
 * Type guard for safely asserting that something is an OpLogEntry.
 */
export function isValidOplogEntry(thing: unknown): thing is OpLogEntry {
  if (!thing) {
    return false;
  }

  const candidate = thing as OpLogEntry;

  if (
    typeof candidate.hlcTime !== 'string' ||
    typeof candidate.store !== 'string' ||
    typeof candidate.objectKey !== 'string' ||
    (typeof candidate.prop !== 'string' && candidate.prop !== null) ||
    !('value' in candidate)
  ) {
    return false;
  }

  if (!HLTime.parse(candidate.hlcTime)) {
    return false;
  }

  return true;
}

export const log = {
  warn(message: string, ...args: unknown[]): void {
    console.warn('[IDBSideSync:warn] ' + message, ...args);
  },

  error(message: string, ...args: unknown[]): void {
    console.error('[IDBSideSync:error] ' + message, ...args);
  },

  debug(message: string, ...args: unknown[]): void {
    if (process.env.NODE_ENV !== 'production') {
      console.log('[IDBSideSync:debug] ' + message, ...args);
    }
  },
};
