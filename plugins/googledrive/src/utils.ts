export const libName = 'IDBSideSync.plugins.googledrive';
export const logPrefix = '[' + libName + ']';

export function noOp() {}

export let debug = process.env.NODE_ENV !== 'production';
if ('DEBUG' in process.env) {
  debug = process.env.DEBUG === 'true';
}

export function setDebug(isEnabled: boolean) {
  debug = isEnabled === true;
}

/* eslint-disable no-console */
export const log = {
  log: console.log.bind(console, logPrefix),
  debug: debug ? console.log.bind(console, logPrefix) : noOp,
  warn: console.warn.bind(console, logPrefix),
  error: console.error.bind(console, logPrefix),
};
/* eslint-enable no-console */
