# Contributing

## Dev Environment

### "Core" Library

The "core" library lives in the [`lib`](./lib) folder. After running `npm install`, you can use:
  - `npm test` to run both Jest and Cypress tests
  - `npm run build` to build the library
  - or `npm run watch` to rebuild the library each time you save changes

For more info see [`lib/package.json`](./lib/package.json).

### Google Drive Plugin

After running `npm install` in [`plugins/googledrive`](./plugins/googledrive), you can use:
  - `npm test` to run unit tests
  - `npm run build` to build the library
  - or `npm run watch` to rebuild the library each time you save changes

For more info see [`plugins/googledrive/README.md`](./plugins/googledrive/README.md).

### ToDo Demo App

While it's really just a simple index.html file that pulls in some JavaScript without using a bundler, the demo app does need to be accessed through a web server for the Google Drive plugin to work correctly (i.e., because the Google API / OAuth workflow doesn't work with `file://` URLs). There are other some npm "convenience" scripts that will automatically copy in new versions of the core and Google Drive plugin libraries whenever they are rebuilt.

After running `npm install` in [`app_demos/plainjs_todos`](./app_demos/plainjs_todos), you can use:
  - `npm start` to serve the demo app at [http://localhost](http://localhost).
  - `npm watch` to both serve the app at localhost _and_ watch the `lib/dist` and `plugins/googledrive/dist` directories for changes, automatically copying in new versions of those libraries whenever they are rebuilt.

## Other stuff

### Code Comments

This project embraces the "code comments empower developers" school of thought and encourages contributors to be generous with inline code documentation. More experienced developers who feel that code should speak for itself hopefully have the option to minimize or collapse comments in their preferred editors.