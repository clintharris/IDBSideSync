# IDBSideSync GDrive Plugin

The IDBSideSync GDrive Plugin is a JavaScript library meant to be used with IDBSideSync. While IDBSideSync provides the ability to proxy requests to IndexedDB data stores and persist database CRUD operations as CRDT-compatible "oplog" messages, the GDrive Plugin is focused on syncing those messages with Google Drive.

# Usage

## 1. Set up Google API credentials for your app.

For your users to sync data with Google Drive, they'll need to grant your app permission to access their Google Drive data (i.e., using an OAuth access token and the Google Drive API). This means you'll need to create a new project in the [Google Developer Console](https://console.developers.google.com) and create credentials for a web app.

Many of the Google API examples show an API Key being used in addition to the client ID. Note that for in-browser applications (i.e., a website or PwA) you should _only_ use the `clientId`. If you select "Create Credentials: Help me Choose" in the Developer Console and indicate that your application will run in browsers, it will generate credentials that only include a `clientId`, _not_ an API Key.

## 2. Load the plugin.

You'll need to ensure that the plugin is loaded before it is used:

```javascript
if (!IDBSideSync.plugins.googledrive.isLoaded()) {
  try {
    await IDBSideSync.plugins.googledrive.load({ clientId: '<your client ID here>' });
  } catch (error) {
    console.error('Failed to load IDBSideSync Google Drive plugin:', error);
  }
}
```

Under the hood this inserts a `<script>` element into your site's DOM for loading the [Google API JavaScript client](https://github.com/google/google-api-javascript-client) (a.k.a., the "GAPI" library) file from Google's servers. If your application already loads the GAPI library, that's fine--the IDBSideSync GDrive Plugin will use the same `window.gapi.*` global that is automatically created when the GAPI client is loaded. Similarly, your application can use the `window.gapi.*` global loaded by the GDrive Plugin.

## 2. Ensure your user is signed in to Google OAuth and granted your app the ability to read/write to Google Drive.

If this is the first time the user has signed in, this will cause the Google sign-in pop-up to appear and walk them through the process of granting your application permission to access Google Drive on their behalf.

```javascript
// Optional: listen for sign-in changes
IDBSideSync.plugins.googledrive.onSignIn((googleUser) => {
  console.log('User signed into Google:', googleUser);
});

try {
  IDBSideSync.plugins.googledrive.signIn();
} catch (error) {
  console.error('Google sign-in failed:', error);
}
```

Note that, by default, the GDrive Plugin is set up to only request the minimum set of Google OAuth permissions needed to sync its own data. Currently that consists of the following (i.e., your users will be prompted to authorize these permissions):

  - Ability to access folders that the application itself has created.
  - Basic Google profile info (e.g., name, email). Access to this data is requested by default and can't be disabled.

If your application uses the GAPI client independently of the IDBSideSync GDrive Plugin and has been configured to request other permissions/scopes, you may see those in addition to those mentioned above.


# Roadmap

- [x] Create simple GDrive test app to help learn how to use the gapi library, OAuth, etc.
- [x] Incorporate the library via `<script src...>` into the main `example-plainjs` app
- [ ] Build a really basic version of `.sync()` that just uploads oplog entries to GDrive

# Technical notes

## Google Drive Access

For the library to work, users of your app will need to see the Google OAuth pop-up and agree to it requesting permission to manage files/folders that the app has created:

![Google Drive OAuth pop-up screenshot](./docs/gdrive-oauth-popup-screenshot.png)

More specifically, this means the library requires the `https://www.googleapis.com/auth/drive.file` scope, which allows the app to:
  - View files from Google Drive that the user has opened with your app or that are shared publicly
  - Save changes to files that the user has opened with your app
  - Create new files in Google Drive using your app
  - View folders and their contents from Google Drive that the user has opened with your app
  - Make changes to folders and their contents that the user has opened with your app
  - Delete contents of folders that the user has opened with your app

The library deliberately avoids requesting "full access" to google drive (i.e., the `https://www.googleapis.com/auth/drive` scope).

It also avoids using a Google Drive [Application Data](https://developers.google.com/drive/api/v3/appdata) folder (i.e., the `https://www.googleapis.com/auth/drive.appdata` scope) since [users can't easily access these folders](https://stackoverflow.com/a/36487545/62694) or the files in them, which really goes against the idea that someone should be able to view and download their own data.
