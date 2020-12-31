import { v4 as uuid } from 'uuid';

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
