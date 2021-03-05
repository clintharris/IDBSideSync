export class GDriveOpLogStore implements OpLogStore {
  getEntries() {
    //todo: get all files from remote folder using gapi.client.drive.
    return [];
  }

  //@ts-ignore
  addEntry(entry: OpLogEntry): Promise<void> {
    return Promise.resolve();
  }
}
