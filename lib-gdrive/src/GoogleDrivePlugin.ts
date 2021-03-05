import { GDriveOpLogStore } from './GDriveOpLogStore';
import { debug, libName, log } from './utils';

// For full list of drive's supported MIME types: https://developers.google.com/drive/api/v3/mime-types
const GAPI_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

// Defines list of fields that we want to be populated on each file object we get from Google. For full list of file
// fields, see https://developers.google.com/drive/api/v3/reference/files
const GAPI_FILE_FIELDS = 'id, name, createdTime';

type SignInChangeHandler = (currentUserProfile: UserProfile | null) => void;

export class GoogleDrivePlugin implements SyncPlugin {
  private clientId: string;

  private listeners: {
    signIn: SignInChangeHandler[];
  } = {
    signIn: [],
  };

  constructor(options: { clientId: string; onSignIn?: SignInChangeHandler }) {
    if (!options || typeof options.clientId !== 'string') {
      const errMsg = `Missing options param with clientId. Example: setup({ clientId: '...' })`;
      log.error(errMsg);
      throw new Error(`[${libName}] ${errMsg}`);
    }

    this.clientId = options.clientId;

    if (options.onSignIn instanceof Function) {
      this.listeners.signIn.push(options.onSignIn);
    }
  }

  public getStore(): OpLogStore {
    return new GDriveOpLogStore();
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
            console.log('ua:', ua);
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

  private onSignInChange(isSignedIn: boolean) {
    const currentUser = isSignedIn ? this.getCurrentUser() : null;
    this.listeners.signIn.forEach((handleSignInChange) => {
      handleSignInChange(currentUser);
    });
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
  private onCurrentUserChange(googleUser: gapi.auth2.GoogleUser) {
    debug && log.debug(`New user:`, googleUser);
    const currentUser = this.getCurrentUser();
    this.listeners.signIn.forEach((handleSignInChange) => {
      handleSignInChange(currentUser);
    });
  }

  public isSignedIn(): boolean {
    return gapi.auth2.getAuthInstance().isSignedIn.get();
  }

  public signIn(): Promise<gapi.auth2.GoogleUser> {
    return gapi.auth2.getAuthInstance().signIn({
      fetch_basic_profile: false,
      ux_mode: 'popup',
    });
  }

  public signOut(): void {
    gapi.auth2.getAuthInstance().signOut();
  }

  public getCurrentUser(): UserProfile {
    const userProfile = gapi.auth2
      .getAuthInstance()
      .currentUser.get()
      .getBasicProfile();
    return {
      email: userProfile.getEmail(),
      firstName: userProfile.getGivenName(),
      lastName: userProfile.getFamilyName(),
    };
  }

  public listFolders(): Promise<GoogleFile[]> {
    return new Promise((resolve, reject) => {
      gapi.client.drive.files
        .list({
          spaces: 'drive',
          q: `mimeType='${GAPI_FOLDER_MIME_TYPE}'`,
          pageSize: 10,
          // See https://developers.google.com/drive/api/v3/reference/files for list of all the file properties. Note
          // that you can request `files(*)` if you want each file object to be populated with all fields.
          fields: `nextPageToken, files(${GAPI_FILE_FIELDS})`,
        })
        .then(function(response) {
          debug && log.debug(`Retrieved folders:`, response.result);
          resolve(Array.isArray(response.result.files) ? (response.result.files as GoogleFile[]) : []);
        })
        .catch((error) => {
          log.error(`Error while attempting to retrieve list of folders from Google Drive:`, error);
          reject(error);
        });
    });
  }

  public createFolder(folderName: string): Promise<GoogleFile> {
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
}
