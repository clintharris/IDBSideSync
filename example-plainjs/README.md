# Overview

This is a basic to-do app for testing/demoing IDBSideSync.

# Usage

```
# Build the libraries
cd lib-core; npm run build
cd ../plugins/googledrive; npm run build

# Start a local web server
cd ../example-plainjs
npm run watch

# Open http://localhost:3000/ in your browser
```

If you don't care about syncing with a remote storage provider, you can just open the `index.html` by double-clicking on it. The main reason for using a web server is due to 3rd-party remote storage libraries (e.g., [Google's JavaScript client library](https://github.com/google/google-api-javascript-client/blob/master/docs/faq.md#can-i-use-the-javascript-client-library-to-work-with-local-files-using-the-file-protocol) and OAuth not working via the `file://` protocol.

# Troubleshooting

Some of the issues you can encounter may be resolved by [troubleshooting the Google API JavaScript client](https://developers.google.com/drive/api/v3/quickstart/js?pli=1#troubleshooting); specifically, things related to OAuth (e.g., you will need to turn off things like Firefox's "enhanced tracking protection" since Google needs the browser to allow 3rd-party cookies and data storage).
