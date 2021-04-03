export const libName = 'IDBSideSync.plugins.googledrive';
export const logPrefix = '[' + libName + ']';

export function noOp() {}

export let debug = process.env.NODE_ENV !== 'production';

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

export const FILENAME_PART = {
  clientPrefix: 'clientId:',
  merkleExt: '.oplogmerkle.json',
  messageExt: '.oplogmsg.json',
};

export function oplogEntryToFileName(params: {
  time: Date;
  counter: number;
  clientId: string;
  entry: OpLogEntry;
}): string {
  // Ensure filename tokens are separated by SPACES, otherwise partial-matching in `listGoogleDriveFiles()` breaks.
  // Example: `<hlc time> <counter> ${FILENAME_PART.clientPrefix}<nodeId>.${FILENAME_PART.messageExt}`
  let fileName =
    params.time.toISOString() +
    ' ' +
    params.counter +
    ' ' +
    FILENAME_PART.clientPrefix +
    params.clientId +
    FILENAME_PART.messageExt;
  return fileName;
}

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

export class FileUploadError extends Error {
  constructor(error: unknown) {
    super(`${libName}: Error on attempt to upload file: ` + error);
    Object.setPrototypeOf(this, FileUploadError.prototype); // https://git.io/vHLlu
  }
}
