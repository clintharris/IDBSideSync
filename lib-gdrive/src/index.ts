import { debug, log } from './utils';

interface UserProfile {
  email: string;
  firstName: string;
  lastName: string;
}

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
      // authInstance.isSignedIn.listen(updateSignInStatus);
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
 * This function should be called whenever the current Google user changes (i.e., it should be passed to
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

  // This seems to be the old, auth v1 way of refreshing the OAuth access token:
  // gapi.auth.authorize({
  //   client_id: '123',
  //   // If immediate=true, the token is refreshed behind the scenes, and no UI is shown to the user
  //   immediate: true
  // }, (authResult: GoogleApiOAuth2TokenObject) => {
  //   gapi.auth.setToken(authResult)
  // });

  // This seems to be the auth2 way of refreshing the OAuth access token:
  // gapi.auth2.getAuthInstance().currentUser.get().reloadAuthResponse();
}
