import {
  debug,
  FileDownloadError,
  FileListError,
  FILENAME_PART,
  FileUploadError,
  libName,
  log,
  oplogEntryToFileName,
} from './utils';

// For full list of drive's supported MIME types: https://developers.google.com/drive/api/v3/mime-types
export const GAPI_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

// Defines list of fields that we want to be populated on each file object we get from Google. For full list of file
// fields, see https://developers.google.com/drive/api/v3/reference/files
export const GAPI_FILE_FIELDS = 'id, name, createdTime, webViewLink';

export const DEFAULT_GAPI_FILE_LIST_PARAMS = {
  spaces: 'drive',
  pageSize: 10,
  orderBy: 'createdTime',
  // See https://developers.google.com/drive/api/v3/reference/files for list of all the file properties. Note that you
  // can request `files(*)` if you want each file object to be populated with all fields.
  fields: `nextPageToken, files(${GAPI_FILE_FIELDS})`,
};

export class GoogleDrivePlugin implements SyncPlugin {
  public static PLUGIN_ID = libName;

  private googleAppClientId: string;
  private remoteFolderName: string;
  private remoteFolderId?: string;
  private remoteFolderLink?: string;
  private mostRecentUploadedEntryTimeMsec: number = 0;

  private listeners: {
    signInChange: SignInChangeHandler[];
  } = {
    signInChange: [],
  };

  constructor(options: {
    googleAppClientId: string;
    defaultFolderName: string;
    remoteFolderId?: string;
    onSignInChange?: SignInChangeHandler;
  }) {
    if (!options || typeof options.googleAppClientId !== 'string') {
      const errMsg = `Missing options param with googleAppClientId. Example: setup({ googleAppClientId: '...' })`;
      log.error(errMsg);
      throw new Error(`[${libName}] ${errMsg}`);
    }

    this.googleAppClientId = options.googleAppClientId;
    this.remoteFolderName = options.defaultFolderName;

    if (typeof options.remoteFolderId === 'string') {
      this.remoteFolderId = options.remoteFolderId;
    }

    if (options.onSignInChange instanceof Function) {
      this.addSignInChangeListener(options.onSignInChange);
    }
  }

  public getPluginId() {
    return libName;
  }

  public isLoaded(): boolean {
    return window.gapi !== undefined && window.gapi.client !== undefined;
  }

  public load(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isLoaded()) {
        debug && log.debug(`Skipping <script> injections for Google API Client .js file; window.gapi already exists.`);
        return resolve('skipped-script-injection');
      }
      debug && log.debug(`Loading GAPI <script>...`);
      const script = document.createElement('script');
      script.onload = resolve;
      script.onerror = reject;
      script.src = 'https://apis.google.com/js/api.js';
      document.head.appendChild(script);
    })
      .then((result) => {
        return new Promise((resolve) => {
          if (result !== 'skipped-script-injection') {
            debug && log.debug(`GAPI <script> successfully loaded.`);
          }
          if (gapi.auth2 && gapi.client.drive) {
            return resolve('skipped-module-load');
          }
          debug && log.debug(`Loading GAPI library modules...`);
          // Warning: passing a config object as the second argument to `gapi.load()` does NOT work in Safari.
          gapi.load('client:auth2', resolve);
        });
      })
      .catch((error) => {
        if (error && error.type === 'error' && error.target && error.target.nodeName === 'SCRIPT') {
          const ua = navigator.userAgent.toLowerCase();
          let errorMsg =
            'Failed to load the Google API JavaScript library. This may be happening due to your browser being ' +
            'configured to use content blocking.';

          if (ua.includes('safari') && ua.includes('mobile')) {
            errorMsg +=
              `\n\nTap on the "aA" shown on the left side of Safari's address bar and select "Turn off ` +
              'Content Blockers", then refresh the app to try again.';
          }
          log.error(errorMsg, error);
          throw new Error(`[${libName}] ${errorMsg}`);
        }
        throw error;
      })
      .then((result) => {
        if (result !== 'skipped-module-load') {
          debug && log.debug(`GAPI library modules successfully loaded.`);
        }
        debug && log.debug(`Initializing GAPI client...`);
        return window.gapi.client
          .init({
            // Note that `apiKey` is NOT specified here, only the (OAuth) Client ID. When setting up app credentials in
            // the Google Developer Console via "Create Credentials > Help Me Choose" the console explains that it's not
            // safe to use some creds in certain contexts. If you select Google Drive, indicate that the app will run in
            // a browser, and specify that the application will access user data, it states that only the clientId can
            // be used securely. See https://developer.okta.com/blog/2019/01/22/oauth-api-keys-arent-safe-in-mobile-apps
            // for more info on why including the API key in a browser app is a bad idea.
            clientId: this.googleAppClientId,
            discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
            scope: 'https://www.googleapis.com/auth/drive.file',
          })
          .then(() => {
            debug && log.debug(`GAPI client successfully initialized.`);
            debug && log.debug(`Setting up GAPI auth change listeners.`);
            const authInstance = gapi.auth2.getAuthInstance();
            authInstance.isSignedIn.listen(this.onSignInChange.bind(this));
            authInstance.currentUser.listen(this.onCurrentUserChange.bind(this));
          });
      });
  }

  public addSignInChangeListener(handlerFcn: SignInChangeHandler) {
    if (handlerFcn instanceof Function && !this.listeners.signInChange.includes(handlerFcn)) {
      this.listeners.signInChange.push(handlerFcn);
    }
  }

  public removeSignInChangeListener(handlerFcn: SignInChangeHandler) {
    const foundAtIndex = this.listeners.signInChange.indexOf(handlerFcn);
    if (foundAtIndex > -1) {
      this.listeners.signInChange = [
        ...this.listeners.signInChange.slice(0, foundAtIndex),
        ...this.listeners.signInChange.slice(foundAtIndex + 1),
      ];
    }
    if (handlerFcn instanceof Function && !this.listeners.signInChange.includes(handlerFcn)) {
      this.listeners.signInChange.push(handlerFcn);
    }
  }

  public isSignedIn(): boolean {
    return gapi.auth2.getAuthInstance().isSignedIn.get();
  }

  public signIn(): Promise<void> {
    return new Promise((resolve, reject) => {
      gapi.auth2
        .getAuthInstance()
        .signIn({ fetch_basic_profile: false, ux_mode: 'popup' })
        .then(() => {
          debug && log.debug(`GAPI client sign-in completed successfully.`);
          resolve();
        })
        .catch((error) => {
          log.error(`GAPI client sign-in failed:`, error);
          let errorMsg = `Google sign-in process failed.`;
          if (error && error.error === 'popup_blocked_by_browser') {
            errorMsg += ` Please try disabling pop-up blocking for this site.`;
          }
          reject(new Error(errorMsg));
        });
    });
  }

  public signOut(): void {
    gapi.auth2.getAuthInstance().signOut();
  }

  public getUserProfile(): UserProfile {
    const googleUserProfile = gapi.auth2
      .getAuthInstance()
      .currentUser.get()
      .getBasicProfile();
    return this.convertGoogleUserProfileToStandardUserProfile(googleUserProfile);
  }

  public getSettings(): SyncProfileSettings {
    return {
      remoteFolderName: this.remoteFolderName,
      remoteFolderId: this.remoteFolderId,
      remoteFolderLink: this.remoteFolderLink,
      mostRecentUploadedEntryTime: this.mostRecentUploadedEntryTimeMsec,
    };
  }

  public setSettings(settings: SyncProfileSettings) {
    if (typeof settings.remoteFolderName === 'string' && settings.remoteFolderName !== '') {
      this.remoteFolderName = settings.remoteFolderName;
    }

    if (typeof settings.remoteFolderId === 'string' && settings.remoteFolderId !== '') {
      this.remoteFolderId = settings.remoteFolderId;
    }

    if (typeof settings.remoteFolderLink === 'string' && settings.remoteFolderLink !== '') {
      this.remoteFolderLink = settings.remoteFolderLink;
    }

    if (typeof settings.mostRecentUploadedEntryTime === 'number') {
      this.mostRecentUploadedEntryTimeMsec = settings.mostRecentUploadedEntryTime;
    }

    this.setupRemoteFolder();
  }

  /**
   * This function will be called after every successful sign-in (assuming it is set up as the handler for
   * `gapi.auth2.getAuthInstance().currentUser.listen(...)`).
   *
   * Note that even after the initial sign-in, this function will continue to get called every hour. This happens
   * because Google OAuth access tokens expire after one hour and the GAPI client will automatically requests a new
   * access token so that the client will continue to be usable; every time a new access token is requested, the
   * "currentUser" change handler will get called.
   *
   * Google likely does this to limit the amount of time an access key is valid if it were to be intercepted.
   */
  private async onCurrentUserChange(googleUser: gapi.auth2.GoogleUser) {
    const googleUserProfile = googleUser.getBasicProfile();
    await this.setupRemoteFolder();
    this.dispatchSignInChangeEvent(this.convertGoogleUserProfileToStandardUserProfile(googleUserProfile));
  }

  public async setupRemoteFolder() {
    log.debug(`Attempting to find remote folder with criteria:`, {
      name: this.remoteFolderName,
      fileId: this.remoteFolderId,
    });
    if (!this.remoteFolderId) {
      log.debug(`Google Drive folder ID for '${this.remoteFolderName}' is unknown; attempting to find/create...`);
      const existingFolderListPage = await this.getFileListPage({ type: 'folders', exactName: this.remoteFolderName });
      if (existingFolderListPage.files.length) {
        const existingFolder = existingFolderListPage.files[0];
        log.debug(`Found existing Google Drive folder with name '${this.remoteFolderName}`, existingFolder);
        this.remoteFolderId = existingFolder.id;
        this.remoteFolderLink = existingFolder.webViewLink;
      } else {
        log.debug(`No folder with name '${this.remoteFolderName}' exists in Google Drive; attempting to create...`);
        const newFolder = await this.createGoogleDriveFolder(this.remoteFolderName);
        log.debug(`Created new Google Drive folder with name '${this.remoteFolderName}'`, newFolder);
        this.remoteFolderId = newFolder.id;
        this.remoteFolderLink = newFolder.webViewLink;
      }
    } else {
      const existingFolder = await this.getFile(this.remoteFolderId);
      if (existingFolder) {
        if (typeof existingFolder.name === 'string' && existingFolder.name.trim() !== '') {
          log.debug(`Successfully found remote folder:`, existingFolder);
          this.remoteFolderName = existingFolder.name;
          this.remoteFolderLink = existingFolder.webViewLink;
        } else {
          throw new Error(`${libName} Google Drive folder with ID '${this.remoteFolderId}' lacks valid name.`);
        }
      } else {
        log.debug(`No folder with ID '${this.remoteFolderId}' exists in Google Drive; attempting to create...`);
        const newFolder = await this.createGoogleDriveFolder(this.remoteFolderName);
        log.debug(`Created new Google Drive folder with name '${this.remoteFolderName}'`, newFolder);
        this.remoteFolderId = newFolder.id;
        this.remoteFolderLink = newFolder.webViewLink;
      }
    }
  }

  private onSignInChange(isSignedIn: boolean) {
    const userProfile = isSignedIn ? this.getUserProfile() : null;
    this.dispatchSignInChangeEvent(userProfile);
  }

  private dispatchSignInChangeEvent(userProfile: UserProfile | null) {
    const settings = this.getSettings();
    for (const signInHandlerFcn of this.listeners.signInChange) {
      if (signInHandlerFcn instanceof Function) {
        signInHandlerFcn(userProfile, settings);
      }
    }
  }

  private convertGoogleUserProfileToStandardUserProfile(googleUserProfile: gapi.auth2.BasicProfile): UserProfile {
    return {
      email: googleUserProfile.getEmail(),
      firstName: googleUserProfile.getGivenName(),
      lastName: googleUserProfile.getFamilyName(),
    };
  }

  public getFile(fileId: string): Promise<gapi.client.drive.File> {
    return new Promise((resolve, reject) => {
      // debug && log.debug(`Attempting to get Google Drive file with ID '${fileId}'...`);
      gapi.client.drive.files
        .get({
          fileId: fileId,
          fields: GAPI_FILE_FIELDS,
        })
        .then(function(response) {
          // debug && log.debug(`Retrieved file:`, response.result);
          resolve(response.result);
        })
        .catch((error) => {
          log.error(`Error while attempting to get file '${fileId}' from Google Drive:`, error);
          reject(error);
        });
    });
  }

  /**
   * GAPI convenience wrapper for listing files.
   */
  public async getFileListPage(filter: {
    type: 'files' | 'folders';
    exactName?: string;
    nameContains?: string[];
    nameNotContains?: string[];
    pageToken?: string;
    pageSize?: number;
    createdAfter?: Date;
    limitToPluginFolder?: boolean;
  }): Promise<{ files: GoogleFile[]; nextPageToken?: string | undefined }> {
    const queryParts = [];
    queryParts.push('mimeType ' + (filter.type === 'folders' ? '=' : '!=') + ` '${GAPI_FOLDER_MIME_TYPE}'`);

    if (typeof filter.exactName === 'string') {
      queryParts.push(`name = '${filter.exactName}'`);
    } else {
      // The GAPI `name contains '<string>'` syntax doesn't work like a wildcard search. It only matches a file if:
      //   - File name begins with, or ends with <string>
      //   - File name contains a space followed by <string> (i.e., ' <string>')
      //
      // Example search "name contains 'foo'":
      //
      //  - ✅ "foobar aaa": matches because overall string starts with "foo"
      //  - ✅ "aaa foobar": matches because, after splitting on spaces, a word starts with "foo"
      //  - ✅ "aaaafoo": matches because overall string ENDS with "foo"
      //  - ❌ "aaaafoo bar": does NOT match
      //  - ❌ "aaa_foo_bar": does NOT match
      //  - ❌ "aaafoobar": does NOT match
      //
      // For more info see https://developers.google.com/drive/api/v3/reference/query-ref#fields.
      if (Array.isArray(filter.nameContains) && filter.nameContains.length) {
        const includeQuery = filter.nameContains.map((pattern) => `name contains '${pattern}'`).join(' or ');
        queryParts.push('(' + includeQuery + ')');
      }

      if (Array.isArray(filter.nameNotContains) && filter.nameNotContains.length) {
        const excludeQuery = filter.nameNotContains.map((pattern) => `not name contains '${pattern}'`).join(' and ');
        queryParts.push('(' + excludeQuery + ')');
      }
    }

    if (filter.createdAfter instanceof Date) {
      queryParts.push(`createdTime > '${filter.createdAfter.toISOString()}'`);
    }

    if (filter.limitToPluginFolder) {
      if (!this.remoteFolderId) {
        const errMsg = `Remote folder ID hasn't been set; file listing can't proceed.`;
        log.error(errMsg);
        throw new Error(libName + ' ' + errMsg);
      }
      queryParts.push(`('${this.remoteFolderId}' in parents)`);
    }

    const listParams: Parameters<typeof gapi.client.drive.files.list>[0] = { ...DEFAULT_GAPI_FILE_LIST_PARAMS };
    listParams.q = queryParts.join(' and ');

    if (typeof filter.pageSize === 'number') {
      listParams.pageSize = filter.pageSize;
    }

    if (typeof filter.pageToken === 'string' && filter.pageToken.trim().length > 0) {
      listParams.pageToken = filter.pageToken;
    }

    debug && log.debug('Attempting to list Google Drive files/folders with filter:', listParams);

    try {
      // For more info on 'list' operation see https://developers.google.com/drive/api/v3/reference/files/list
      const response = await gapi.client.drive.files.list(listParams);
      // debug && log.debug('GAPI files.list() response:', response);
      return {
        files: Array.isArray(response.result.files) ? (response.result.files as GoogleFile[]) : [],
        nextPageToken: response.result.nextPageToken,
      };
    } catch (error) {
      log.error(`Error while attempting to retrieve list of folders from Google Drive:`, error);
      throw new FileListError(error);
    }
  }

  public createGoogleDriveFolder(folderName: string): Promise<GoogleFile> {
    return new Promise((resolve, reject) => {
      gapi.client.drive.files
        .create({
          resource: {
            name: folderName,
            mimeType: GAPI_FOLDER_MIME_TYPE,
          },
          fields: GAPI_FILE_FIELDS,
        })
        .then(function(response) {
          switch (response.status) {
            case 200:
              debug && log.debug(`Created folders`, response.result);
              const folder = response.result;
              resolve(folder as GoogleFile);
              return;
            default:
              const errorMsg = `Received error response on attempt to create folder:`;
              log.error(errorMsg, response);
              throw new Error(`[${libName}] ${errorMsg} ${response.body}`);
          }
        })
        .catch((error) => {
          log.error(`Failed to create folder:`, error);
          reject(error);
        });
    });
  }

  /**
   * Returns the time of the most recent oplog entry known to have been uploaded to the remote server for the current
   * client. Ideally this would be determined by querying Google Drive. That approach involves asking the Google Drive
   * API to order the results of a "list files" operation (i.e., order by date). Unfortunately, as of April 2021, the
   * "list files" documentation states that "order by" doesn't work for users that have > ~1M files (see `orderBy` in
   * https://developers.google.com/drive/api/v3/reference/files/list). To avoid that problem (even though it's rare),
   * we're going to determine "most recent uploaded entry" by using a local state variable that is updated whenever
   * oplog entries are uploaded.
   */
  public async getMostRecentUploadedEntryTime(): Promise<Date> {
    return new Date(this.mostRecentUploadedEntryTimeMsec);
  }

  /**
   * A convenience function that wraps the paginated results of `getFileListPage()` and returns an async generator so
   * that you can do something like the following:
   *
   * @example
   * ```
   * for await (let record of getRemoteClientRecords()) {
   *   await doSomethingAsyncWith(record)
   * }
   * ```
   *
   * For more info on async generators, etc., see https://javascript.info/async-iterators-generators.
   */
  public async *getRemoteClientRecords(
    filter: {
      includeClientIds?: string[];
      excludeClientIds?: string[];
    } = {}
  ): AsyncGenerator<ClientRecord, void, void> {
    debug && log.debug('Attempting to get remote client record(s) from Google Drive using filter criteria:', filter);

    const nameContains = Array.isArray(filter.includeClientIds)
      ? filter.includeClientIds.map((clientId) => clientId + FILENAME_PART.clientInfoExt)
      : [FILENAME_PART.clientInfoExt];

    const nameNotContains = Array.isArray(filter.excludeClientIds)
      ? filter.excludeClientIds.map((clientId) => clientId + FILENAME_PART.clientInfoExt)
      : undefined;

    let pageResults;
    let pageToken: undefined | string = '';

    while (pageToken !== undefined) {
      pageResults = await this.getFileListPage({
        type: 'files',
        nameContains,
        nameNotContains,
        pageToken,
        limitToPluginFolder: true,
      });
      pageToken = pageResults.nextPageToken;

      log.debug(`Found ${pageResults.files.length} client record files (${pageToken ? '' : 'no '}more pages exist).`);

      for (const file of pageResults.files) {
        try {
          debug && log.debug(`Attempting to download '${file.name}' (file ID: ${file.id}).`);
          let response = await gapi.client.drive.files.get({ fileId: file.id, alt: 'media' });
          const clientIdWithPrefix = file.name.split('.')[0];
          const clientId = clientIdWithPrefix.replace(FILENAME_PART.clientPrefix, '');
          yield { clientId, data: response.result };
        } catch (error) {
          const fileName = `'${file.name}' (file ID: ${file.id})`;
          log.error(`Error on attempt to download '${fileName}:`, error);
          throw new FileDownloadError(fileName, error);
        }
      }
    }
  }

  public async *getRemoteEntries(params: {
    clientId: string;
    afterTime?: Date | null;
  }): AsyncGenerator<OpLogEntry, void, void> {
    debug && log.debug('Attempting to get oplog entries from Google Drive:', params);

    const nameContains = [FILENAME_PART.clientPrefix + params.clientId + FILENAME_PART.messageExt];

    let pageResults;
    let pageToken: undefined | string = '';

    while (pageToken !== undefined) {
      pageResults = await this.getFileListPage({
        type: 'files',
        nameContains,
        createdAfter: params.afterTime instanceof Date ? params.afterTime : undefined,
        pageToken,
        pageSize: 25,
        limitToPluginFolder: true,
      });
      pageToken = pageResults.nextPageToken;

      log.debug(`Found ${pageResults.files.length} oplog entry files (${pageToken ? '' : 'no '}more pages exist).`);

      for (const file of pageResults.files) {
        try {
          debug && log.debug(`Attempting to download '${file.name}' (file ID: ${file.id}).`);
          let response = await gapi.client.drive.files.get({ fileId: file.id, alt: 'media' });
          yield response.result as OpLogEntry;
        } catch (error) {
          const fileName = `'${file.name}' (file ID: ${file.id})`;
          log.error(`Error on attempt to download '${fileName}:`, error);
          throw new FileDownloadError(fileName, error);
        }
      }
    }
  }

  // TODO: Investigate batching:
  // https://github.com/google/google-api-javascript-client/blob/master/docs/promises.md#batch-requests
  public async saveRemoteEntry(params: {
    time: Date;
    counter: number;
    clientId: string;
    entry: OpLogEntry;
    overwriteExisting?: boolean;
  }): Promise<{ numUploaded: number }> {
    const entryFileName = oplogEntryToFileName(params);
    debug && log.debug('Attempting to save oplog entry:', entryFileName);

    // WARNING: Google Drive allows multiple files to exist with the same name. Always check to see if a file exists
    // before uploading it and then decide if it should be overwritten (based on existing file's file ID) or ignored.
    let existingFileId;

    try {
      const listParams: Parameters<typeof gapi.client.drive.files.list>[0] = { ...DEFAULT_GAPI_FILE_LIST_PARAMS };
      listParams.q = `name = '${entryFileName}'`;
      const response = await gapi.client.drive.files.list(listParams);
      if (Array.isArray(response.result.files) && response.result.files.length > 0) {
        existingFileId = response.result.files[0].id;
      }
    } catch (error) {
      log.error(`Error while attempting to see if file already exists on server with name ${entryFileName}:`, error);
      throw new FileListError(error);
    }

    if (existingFileId && !params.overwriteExisting) {
      debug && log.debug(`Oplog entry already exists; won't overwrite.`, entryFileName);
      return { numUploaded: 0 };
    }

    await this.saveFile({
      fileId: existingFileId,
      fileName: entryFileName,
      fileData: params.entry,
      // We need to support listing/filtering for oplog entry files whose HL timestamps occur after some date/time. The
      // way we achieve this with Google Drive is to use the 'createdTime' metadata property (since the API actually
      // supports searching by date range using this field), so we'll manually set this field to the oplog entry
      // timestamp.
      createdTime: params.time.toISOString(),
    });

    if (params.time.getTime() > this.mostRecentUploadedEntryTimeMsec) {
      this.mostRecentUploadedEntryTimeMsec = params.time.getTime();
    }

    return { numUploaded: 1 };
  }

  public async saveRemoteClientRecord(clientId: string, options: { overwriteIfExists?: boolean } = {}): Promise<void> {
    debug && log.debug('Attempting to save client record to Google Drive.');

    const fileName = FILENAME_PART.clientPrefix + clientId + FILENAME_PART.clientInfoExt;

    // WARNING: Google Drive allows multiple files to exist with the same name. Always check to see if a file exists
    // before uploading it and then decide if it should be overwritten (based on existing file's file ID) or ignored.
    let existingFileId;

    try {
      const listParams: Parameters<typeof gapi.client.drive.files.list>[0] = { ...DEFAULT_GAPI_FILE_LIST_PARAMS };
      listParams.q = `name = '${fileName}'`;
      debug && log.debug('Checking to see if client record file already exists on server with name:', fileName);
      const response = await gapi.client.drive.files.list(listParams);
      if (Array.isArray(response.result.files) && response.result.files.length > 0) {
        existingFileId = response.result.files[0].id;
      }
    } catch (error) {
      log.error(`Error while attempting to see if file already exists on server with name ${fileName}:`, error);
      throw new FileListError(error);
    }

    if (existingFileId) {
      if (!options.overwriteIfExists) {
        log.debug(`Client record with file name ${fileName} already exists; won't overwrite.`);
        return;
      } else {
        log.debug(`Overwriting existing client record file '${fileName}'.`);
      }
    }

    await this.saveFile({
      fileId: existingFileId,
      fileName: fileName,
      fileData: {},
    });
  }

  /**
   * Convenience function for saving some object to Google Drive.
   */
  public async saveFile(params: {
    fileId?: string; // Specify existing file ID to overwrite existing file contents
    fileName: string;
    fileData: object;
    createdTime?: string;
  }): Promise<{ id: string; name: string }> {
    if (!this.remoteFolderId) {
      const errMsg = `Remote folder ID hasn't been set; files can't be saved without having ID of parent folder.`;
      log.error(errMsg);
      throw new Error(libName + ' ' + errMsg);
    }
    const fileData = JSON.stringify(params.fileData);
    const contentType = 'text/plain';
    const metadata: Record<string, unknown> = params.fileId
      ? {}
      : {
          name: params.fileName,
          mimeType: contentType,
          parents: [this.remoteFolderId],
        };

    if (!params.fileId && typeof params.createdTime === 'string') {
      metadata.createdTime = params.createdTime;
    }

    const boundary = 'multipartformboundaryhere';
    const delimiter = '\r\n--' + boundary + '\r\n';
    const close_delim = '\r\n--' + boundary + '--';

    // Create a request body that looks like this:
    //
    // --multipartformboundaryhere
    // Content-Type: application/json; charset=UTF-8
    //
    // {"name":"798_2021-03-14T12:07:54.248Z","mimeType":"text/plain"}
    // --multipartformboundaryhere
    // Content-Type: text/plain
    //
    // data goes here
    //
    // --multipartformboundaryhere--
    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: ' +
      contentType +
      '\r\n\r\n' +
      fileData +
      '\r\n' +
      close_delim;

    try {
      const response = await gapi.client.request({
        path: 'https://www.googleapis.com/upload/drive/v3/files' + (params.fileId ? `/${params.fileId}` : ''),
        method: params.fileId ? 'PATCH' : 'POST',
        params: { uploadType: 'multipart' },
        headers: {
          'Content-Type': 'multipart/related; boundary=' + boundary + '',
        },
        body: multipartRequestBody,
      });

      return response.result;
    } catch (error) {
      log.error('Error on attempt to save file:', error);
      throw new FileUploadError(error);
    }
  }
}
