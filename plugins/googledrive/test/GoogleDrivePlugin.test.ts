/// <reference types="../../../types/common" />
import { jest, describe, expect, it } from '@jest/globals';

import { DEFAULT_GAPI_FILE_LIST_PARAMS, GAPI_FOLDER_MIME_TYPE, GoogleDrivePlugin } from '../src/GoogleDrivePlugin';
import { FILENAME_PART, setDebug } from '../src/utils';

// Define the mock GAPI global object before the 'GoogleDrivePlugin' is loaded
stubMockGapiGlobal();

setDebug(false); // Don't display all the log.debug() output while running unit tests.
const defaultConstructorArgs = { clientId: '1234', defaultFolderName: 'foo', remoteFolderId: 'folder123' };

describe('GoogleDrivePlugin', () => {
  describe('listGoogleDriveFiles()', () => {
    it('makes correct GAPI query for folders', async () => {
      // @ts-ignore
      const mockListFcn = jest.spyOn(gapi.client.drive.files, 'list');
      const mockResponse = { body: '', result: { files: [{ id: '1', name: 'file1' }] } };
      mockListFcn.mockResolvedValue(mockResponse);

      const plugin = new GoogleDrivePlugin(defaultConstructorArgs);
      const page = await plugin.getFileListPage({ type: 'folders' });

      expect(page.files).toEqual(mockResponse.result.files);
      expect(mockListFcn).toHaveBeenCalledWith({
        q: `mimeType = '${GAPI_FOLDER_MIME_TYPE}'`,
        ...DEFAULT_GAPI_FILE_LIST_PARAMS,
      });
    });

    it('makes correct GAPI query for files', async () => {
      // @ts-ignore
      const mockListFcn = jest.spyOn(gapi.client.drive.files, 'list');
      const mockResponse = { body: '', result: { files: [{ id: '1', name: 'file1' }] } };
      mockListFcn.mockResolvedValue(mockResponse);

      const plugin = new GoogleDrivePlugin(defaultConstructorArgs);
      const page = await plugin.getFileListPage({ type: 'files' });

      expect(page.files).toEqual(mockResponse.result.files);
      expect(mockListFcn).toHaveBeenCalledWith({
        q: `mimeType != '${GAPI_FOLDER_MIME_TYPE}'`,
        ...DEFAULT_GAPI_FILE_LIST_PARAMS,
      });
    });

    it('makes correct GAPI query for "exactName"', async () => {
      // @ts-ignore
      const mockListFcn = jest.spyOn(gapi.client.drive.files, 'list');
      const mockResponse = { body: '', result: { files: [{ id: '1', name: 'file1' }] } };
      mockListFcn.mockResolvedValue(mockResponse);

      const plugin = new GoogleDrivePlugin(defaultConstructorArgs);
      const page = await plugin.getFileListPage({ type: 'files', exactName: 'foo' });

      expect(page.files).toEqual(mockResponse.result.files);
      expect(mockListFcn).toHaveBeenCalledWith({
        q: `mimeType != '${GAPI_FOLDER_MIME_TYPE}' and name = 'foo'`,
        ...DEFAULT_GAPI_FILE_LIST_PARAMS,
      });
    });

    it('makes correct GAPI query for "nameContains" and "nameNotContains"', async () => {
      // @ts-ignore
      const mockListFcn = jest.spyOn(gapi.client.drive.files, 'list');
      const mockResponse = { body: '', result: { files: [{ id: '1', name: 'file1' }] } };
      mockListFcn.mockResolvedValue(mockResponse);

      const plugin = new GoogleDrivePlugin(defaultConstructorArgs);
      const { files } = await plugin.getFileListPage({ type: 'files', nameContains: ['foo', 'bar'] });

      expect(files).toEqual(mockResponse.result.files);
      expect(mockListFcn).toHaveBeenCalledWith({
        q: `mimeType != '${GAPI_FOLDER_MIME_TYPE}' and (name contains 'foo' or name contains 'bar')`,
        ...DEFAULT_GAPI_FILE_LIST_PARAMS,
      });

      await plugin.getFileListPage({ type: 'files', nameContains: ['foo'] });
      expect(mockListFcn).toHaveBeenCalledWith({
        q: `mimeType != '${GAPI_FOLDER_MIME_TYPE}' and (name contains 'foo')`,
        ...DEFAULT_GAPI_FILE_LIST_PARAMS,
      });

      await plugin.getFileListPage({ type: 'files', nameNotContains: ['foo', 'bar'] });
      expect(mockListFcn).toHaveBeenCalledWith({
        q: `mimeType != '${GAPI_FOLDER_MIME_TYPE}' and (not name contains 'foo' and not name contains 'bar')`,
        ...DEFAULT_GAPI_FILE_LIST_PARAMS,
      });

      await plugin.getFileListPage({ type: 'files', nameContains: ['foo'], nameNotContains: ['bar'] });
      expect(mockListFcn).toHaveBeenCalledWith({
        q: `mimeType != '${GAPI_FOLDER_MIME_TYPE}' and (name contains 'foo') and (not name contains 'bar')`,
        ...DEFAULT_GAPI_FILE_LIST_PARAMS,
      });
    });
  });

  describe('getRemoteMerkles()', () => {
    it('makes correct GAPI query for all merkle files', async () => {
      // @ts-ignore
      const mockListFcn = jest.spyOn(gapi.client.drive.files, 'list');
      const mockListResponse = {
        body: '',
        result: {
          files: [
            { id: '1', name: 'foo' + FILENAME_PART.merkleExt },
            { id: '2', name: 'bar' + FILENAME_PART.merkleExt },
          ],
        },
      };
      mockListFcn.mockResolvedValue(mockListResponse);

      // @ts-ignore
      const mockGetFcn = jest.spyOn(gapi.client.drive.files, 'get');
      const mockGetResponse = {
        body: '',
        result: {
          hash: 333,
          branches: {
            '2': {
              hash: 333,
              branches: {},
            },
          },
        },
      };
      // @ts-ignore
      mockGetFcn.mockResolvedValue(mockGetResponse);

      const plugin = new GoogleDrivePlugin(defaultConstructorArgs);

      const results: ClientIdMerklePair[] = [];
      for await (const clientIdMerklePair of plugin.getRemoteMerkles()) {
        results.push(clientIdMerklePair);
      }

      expect(results).toEqual([
        {
          clientId: 'foo',
          merkle: mockGetResponse.result,
        },
        {
          clientId: 'bar',
          merkle: mockGetResponse.result,
        },
      ]);

      // expect(files).toEqual(mockListResponse.result.files);
      expect(mockListFcn).toHaveBeenCalledWith({
        ...DEFAULT_GAPI_FILE_LIST_PARAMS,
        q:
          `mimeType != '${GAPI_FOLDER_MIME_TYPE}' and (name contains '${FILENAME_PART.merkleExt}') and ` +
          `('${defaultConstructorArgs.remoteFolderId}' in parents)`,
      });
    });
  });

  describe('getRemoteEntries()', () => {
    it.todo('makes correct GAPI query for remote oplog entries');
  });

  describe('saveFile()', () => {
    it.todo('works correctly');
  });

  describe('saveRemoteMerkle()', () => {
    it.todo('works correctly');
  });

  describe('saveRemoteEntry()', () => {
    it.todo('works correctly');
  });
});

function stubMockGapiGlobal() {
  // @ts-ignore
  'gapi.client.drive.files'.split('.').reduce((obj: unknown, name) => (obj[name] = {}), window);

  // @ts-ignore
  gapi.client.drive.files.list = () => {};
  // @ts-ignore
  gapi.client.drive.files.get = () => {};
}
