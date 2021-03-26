import { debug, libName, log } from './utils';

// For full list of drive's supported MIME types: https://developers.google.com/drive/api/v3/mime-types
export const GAPI_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

// Defines list of fields that we want to be populated on each file object we get from Google. For full list of file
// fields, see https://developers.google.com/drive/api/v3/reference/files
export const GAPI_FILE_FIELDS = 'id, name, createdTime, webViewLink';

const FILENAME_PART = {
  clientPrefix: 'clientId:',
  merkleExt: '.oplogmerkle.json',
  messageExt: '.oplogmsg.json',
};

export const defaultFileListParams = {
  spaces: 'drive',
  pageSize: 10,
  orderBy: 'createdTime',
  // See https://developers.google.com/drive/api/v3/reference/files for list of all the file properties. Note that you
  // can request `files(*)` if you want each file object to be populated with all fields.
  fields: `nextPageToken, files(${GAPI_FILE_FIELDS})`,
};

type SignInChangeHandler = (userProfile: UserProfile | null, settings: SyncProfileSettings) => void;

export class GoogleDrivePlugin implements SyncPlugin {
  public static PLUGIN_ID = libName;

  private clientId: string;
  private remoteFolderName: string;
  private remoteFolderId?: string;
  private remoteFolderLink?: string;

  private listeners: {
    signInChange: SignInChangeHandler[];
  } = {
    signInChange: [],
  };

  constructor(options: { clientId: string; defaultFolderName: string; onSignInChange?: SignInChangeHandler }) {
    if (!options || typeof options.clientId !== 'string') {
      const errMsg = `Missing options param with clientId. Example: setup({ clientId: '...' })`;
      log.error(errMsg);
      throw new Error(`[${libName}] ${errMsg}`);
    }

    this.clientId = options.clientId;
    this.remoteFolderName = options.defaultFolderName;

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
            clientId: this.clientId,
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

  public signIn(): void {
    gapi.auth2.getAuthInstance().signIn({ fetch_basic_profile: false, ux_mode: 'popup' });
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
    if (!this.remoteFolderId) {
      log.debug(`Google Drive folder ID for '${this.remoteFolderName}' is unknown; attempting to find/create...`);
      const existingFolders = await this.listGoogleDriveFiles({ type: 'folders', exactName: this.remoteFolderName });
      if (existingFolders.length) {
        const existingFolder = existingFolders[0];
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
          log.debug(`Found existing Google Drive folder with name '${this.remoteFolderName}`, existingFolder);
          this.remoteFolderName = existingFolder.name;
          this.remoteFolderLink = existingFolder.webViewLink;
        } else {
          throw new Error(`${libName} Google Drive folder with ID '${this.remoteFolderId}' lack valid name.`);
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
      debug && log.debug(`Attempting to get Google Drive file with ID '${fileId}'...`);
      gapi.client.drive.files
        .get({
          fileId: fileId,
          fields: GAPI_FILE_FIELDS,
        })
        .then(function(response) {
          debug && log.debug(`Retrieved file:`, response.result);
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
  public listGoogleDriveFiles(filter: {
    type: 'files' | 'folders';
    exactName?: string;
    nameContains?: string[];
    nameNotContains?: string[];
  }): Promise<GoogleFile[]> {
    return new Promise((resolve, reject) => {
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

      debug && log.debug('Attempting to list Google Drive files/folders with filter:', filter);
      // For more info on 'list' operation see https://developers.google.com/drive/api/v3/reference/files/list
      gapi.client.drive.files
        .list({ q: queryParts.join(' and '), ...defaultFileListParams })
        .then(function(response) {
          debug && log.debug(`Retrieved files/folders:`, response.result);
          resolve(Array.isArray(response.result.files) ? (response.result.files as GoogleFile[]) : []);
        })
        .catch((error) => {
          log.error(`Error while attempting to retrieve list of folders from Google Drive:`, error);
          reject(error);
        });
    });
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

  public getRemoteMerkles(filter: {
    includeNodeIds?: string[];
    excludeNodeIds?: string[];
  }): Promise<{ nodeId: string; merkle: MerkleTreeCompatible }[]> {
    debug && log.debug('Attempting to get remote merkle(s) from Google Drive:', filter);
    const remoteMerkles = [];
    remoteMerkles.push({ nodeId: '', merkle: { hash: 0, branches: {} } });
    debug && log.debug(`Downloaded merkle trees from Google Drive:`, remoteMerkles);
    return Promise.resolve(remoteMerkles);
  }

  public async *getRemoteEntries(params: { afterTime?: Date | null } = {}): AsyncGenerator<OpLogEntry, void, void> {
    debug && log.debug('Attempting to get oplog entries from Google Drive:', params);
  }

  public addRemoteEntry(entry: OpLogEntry): Promise<void> {
    debug && log.debug('Attempting to add oplog entry to Google Drive:', entry);

    // WARNING: Google Drive allows multiple files to exist with the same name. Always check to see if a file exists
    // before uploading it and then decide if it should be overwritten (based on existing file's file ID) or ignored.
    return Promise.resolve();
  }

  public saveMerkle(entry: MerkleTreeCompatible): Promise<void> {
    debug && log.debug('Attempting to add oplog entry to Google Drive:', entry);

    // WARNING: Google Drive allows multiple files to exist with the same name. Always check to see if a file exists
    // before uploading, and if one exists, replace it using the corresponding File ID.
    return Promise.resolve();
  }
}
