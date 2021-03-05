import { debug, libName, log } from './utils';

interface UserProfile {
  email: string;
  firstName: string;
  lastName: string;
}

interface GoogleFile {
  id: string;
  name: string;
  createdTime: string;
}

// For full list of drive's supported MIME types: https://developers.google.com/drive/api/v3/mime-types
const GAPI_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

// Defines list of fields that we want to be populated on each file object we get from Google. For full list of file
// fields, see https://developers.google.com/drive/api/v3/reference/files
const GAPI_FILE_FIELDS = 'id, name, createdTime';

let onSignInChangeHandler: ((args: UserProfile) => void) | null = null;

export function needsSetup(): boolean {
  return true;
}

class GDriveOpLogStore implements OpLogStore {
  getEntries() {
    //todo: get all files from remote folder using gapi.client.drive.
    return [];
  }

  //@ts-ignore
  addEntry(entry: OpLogEntry): Promise<void> {
    return Promise.resolve();
  }
}

export function getStore(): OpLogStore {
  return new GDriveOpLogStore();
}

export function isLoaded(): boolean {
  return window.gapi !== undefined && window.gapi.client !== undefined;
}

export function load(options: { clientId: string }): ReturnType<typeof initGDriveClient> {
  if (!options || typeof options.clientId !== 'string') {
    const errMsg = `${libName}.load(): missing options param with clientId. Example: load({ clientId: '...' })`;
    log.error(errMsg);
    throw new Error(errMsg);
  }

  // Remember: the function passed to the Promise constructor (the "executor") is executed immediately.
  return new Promise((resolve, reject) => {
    if (window.gapi) {
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
        throw new Error(errorMsg);
      }
      throw error;
    })
    .then((result) => {
      if (result !== 'skipped-module-load') {
        debug && log.debug(`GAPI library modules successfully loaded.`);
      }
      return initGDriveClient(window.gapi.client, options.clientId);
    });
}

function initGDriveClient(client: typeof gapi.client, clientId: string): Promise<void> {
  debug && log.debug(`Initializing GAPI client...`);
  return client
    .init({
      // Note that `apiKey` is NOT specified here, only the (OAuth) Client ID. When setting up app credentials in the
      // Google Developer Console via "Create Credentials > Help Me Choose" the console explains that it's not safe to
      // use some creds in certain contexts. If you select Google Drive, indicate that the app will run in a browser,
      // and specify that the application will access user data, it states that only the clientId can be used securely.
      // See https://developer.okta.com/blog/2019/01/22/oauth-api-keys-arent-safe-in-mobile-apps for more info on why
      // including the API key in a browser app is a bad idea.
      clientId,
      discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
      scope: 'https://www.googleapis.com/auth/drive.file',
    })
    .then(() => {
      debug && log.debug(`GAPI client successfully initialized.`);
      debug && log.debug(`Setting up GAPI auth change listeners.`);
      const authInstance = gapi.auth2.getAuthInstance();
      authInstance.isSignedIn.listen((newSignInStatus) => {
        console.log({ newSignInStatus });
      });
      authInstance.currentUser.listen(updateCurrentUser);
    });
}

export function isUserSignedIn(): boolean {
  return gapi.auth2.getAuthInstance().isSignedIn.get();
}

export function getCurrentUser(): UserProfile {
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

export function signIn(): Promise<gapi.auth2.GoogleUser> {
  return gapi.auth2.getAuthInstance().signIn({
    fetch_basic_profile: false,
    ux_mode: 'popup',
  });
}

export function signOut(): void {
  gapi.auth2.getAuthInstance().signOut();
}

export function onSignIn(callback: typeof onSignInChangeHandler) {
  onSignInChangeHandler = callback;
}

/**
 * This function will be called after every successful sign-in (assuming it is set up as the handler for
 * `gapi.auth2.getAuthInstance().currentUser.listen(...)`).
 *
 * Note that even after the initial sign-in, this function will continue to get called every hour. This happens because
 * Google OAuth access tokens expire after one hour and the GAPI client will automatically requests a new access token
 * so that the client will continue to be usable; every time a new access token is requested, the "currentUser" change
 * handler will get called.
 *
 * Google likely does this to limit the amount of time an access key is valid if it were to be intercepted.
 */
function updateCurrentUser(googleUser: gapi.auth2.GoogleUser) {
  debug && log.debug(`Handling "current user" change event; new user:`, googleUser);

  //TODO: persist current user info to idb
  const userProfile = googleUser.getBasicProfile();

  if (onSignInChangeHandler) {
    onSignInChangeHandler({
      email: userProfile.getEmail(),
      firstName: userProfile.getGivenName(),
      lastName: userProfile.getFamilyName(),
    });
  }
}

export function listFolders(): Promise<GoogleFile[]> {
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

export function createFolder(folderName: string): Promise<GoogleFile> {
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
            log.error(`Received error response on attempt to create folder:`, response);
            throw new Error(response.body);
        }
      })
      .catch((error) => {
        log.error(`Failed to create folder:`, error);
        reject(error);
      });
  });
}
