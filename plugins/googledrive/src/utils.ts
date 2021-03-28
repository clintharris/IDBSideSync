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

export class FileDownloadError extends Error {
  constructor(fileName: string, error: unknown) {
    super(`${libName}: Error on attempt to download ${fileName}. ` + error);
    Object.setPrototypeOf(this, FileDownloadError.prototype); // https://git.io/vHLlu
  }
}

export class FileListError extends Error {
  constructor(error: unknown) {
    super(`${libName}: Error on attempt to list files: ` + error);
    Object.setPrototypeOf(this, FileListError.prototype); // https://git.io/vHLlu
  }
}
