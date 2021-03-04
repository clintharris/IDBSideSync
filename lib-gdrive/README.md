# Overview

`IDBSideSync-gdrive` is a JavaScript library meant to be used with IDBSideSync. While IDBSideSync provides the ability to proxy requests to IndexedDB data stores and persist database CRUD operations as CRDT-compatible "oplog" messages, `IDBSideSync-gdrive` is focused on syncing those messages with Google Drive.

# Usage


# Roadmap

- [ ] Create simple GDrive test app to help learn how to use the gapi library, OAuth, etc.
- [ ] Build a really basic version of `.sync()` that just uploads oplog entries to GDrive
- [ ] Incorporate the library via `<script src...>` into the main `example-plainjs` app

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


Jest tests are set up to run with `npm test` or `yarn test`.

### Bundle Analysis

[`size-limit`](https://github.com/ai/size-limit) is set up to calculate the real cost of your library with `npm run size` and visualize the bundle with `npm run analyze`.

#### Setup Files

This is the folder structure we set up for you:

```txt
/src
  index.tsx       # EDIT THIS
/test
  blah.test.tsx   # EDIT THIS
.gitignore
package.json
README.md         # EDIT THIS
tsconfig.json
```

### Rollup

TSDX uses [Rollup](https://rollupjs.org) as a bundler and generates multiple rollup configs for various module formats and build settings. See [Optimizations](#optimizations) for details.

### TypeScript

`tsconfig.json` is set up to interpret `dom` and `esnext` types, as well as `react` for `jsx`. Adjust according to your needs.

## Continuous Integration

### GitHub Actions

Two actions are added by default:

- `main` which installs deps w/ cache, lints, tests, and builds on all pushes against a Node and OS matrix
- `size` which comments cost comparison of your library on every pull request using [`size-limit`](https://github.com/ai/size-limit)

## Optimizations

Please see the main `tsdx` [optimizations docs](https://github.com/palmerhq/tsdx#optimizations). In particular, know that you can take advantage of development-only optimizations:

```js
// ./types/index.d.ts
declare var __DEV__: boolean;

// inside your code...
if (__DEV__) {
  console.log('foo');
}
```

You can also choose to install and use [invariant](https://github.com/palmerhq/tsdx#invariant) and [warning](https://github.com/palmerhq/tsdx#warning) functions.

## Module Formats

CJS, ESModules, and UMD module formats are supported.

The appropriate paths are configured in `package.json` and `dist/index.js` accordingly. Please report if any issues are found.

## Named Exports

Per Palmer Group guidelines, [always use named exports.](https://github.com/palmerhq/typescript#exports) Code split inside your React app instead of your React library.

## Including Styles

There are many ways to ship styles, including with CSS-in-JS. TSDX has no opinion on this, configure how you like.

For vanilla CSS, you can include it at the root directory and add it to the `files` section in your `package.json`, so that it can be imported separately by your users and run through their bundler's loader.

## Publishing to NPM

We recommend using [np](https://github.com/sindresorhus/np).
