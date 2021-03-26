/// <reference types="../../../types/common" />
import { jest, describe, expect, it } from '@jest/globals';

import { defaultFileListParams, GAPI_FOLDER_MIME_TYPE, GoogleDrivePlugin } from '../src/GoogleDrivePlugin';

// Define the mock GAPI global object before the 'GoogleDrivePlugin' is loaded
stubMockGapiGlobal();

describe('GoogleDrivePlugin', () => {
  describe('listGoogleDriveFiles()', () => {
    it('makes correct GAPI query for folders', async () => {
      // @ts-ignore
      const listFilesMock = jest.spyOn(gapi.client.drive.files, 'list');
      const mockResponse = { body: '', result: { files: [{ id: '1', name: 'file1' }] } };
      listFilesMock.mockResolvedValue(mockResponse);

      const plugin = new GoogleDrivePlugin({ clientId: '1234', defaultFolderName: 'foo' });
      const files = await plugin.listGoogleDriveFiles({ type: 'folders' });

      expect(files).toEqual(mockResponse.result.files);
      expect(listFilesMock).toHaveBeenCalledWith({
        q: `mimeType = '${GAPI_FOLDER_MIME_TYPE}'`,
        ...defaultFileListParams,
      });
    });

    it('makes correct GAPI query for files', async () => {
      // @ts-ignore
      const listFilesMock = jest.spyOn(gapi.client.drive.files, 'list');
      const mockResponse = { body: '', result: { files: [{ id: '1', name: 'file1' }] } };
      listFilesMock.mockResolvedValue(mockResponse);

      const plugin = new GoogleDrivePlugin({ clientId: '1234', defaultFolderName: 'foo' });
      const files = await plugin.listGoogleDriveFiles({ type: 'files' });

      expect(files).toEqual(mockResponse.result.files);
      expect(listFilesMock).toHaveBeenCalledWith({
        q: `mimeType != '${GAPI_FOLDER_MIME_TYPE}'`,
        ...defaultFileListParams,
      });
    });

    it('makes correct GAPI query for "exactName"', async () => {
      // @ts-ignore
      const listFilesMock = jest.spyOn(gapi.client.drive.files, 'list');
      const mockResponse = { body: '', result: { files: [{ id: '1', name: 'file1' }] } };
      listFilesMock.mockResolvedValue(mockResponse);

      const plugin = new GoogleDrivePlugin({ clientId: '1234', defaultFolderName: 'foo' });
      const files = await plugin.listGoogleDriveFiles({ type: 'files', exactName: 'foo' });

      expect(files).toEqual(mockResponse.result.files);
      expect(listFilesMock).toHaveBeenCalledWith({
        q: `mimeType != '${GAPI_FOLDER_MIME_TYPE}' and name = 'foo'`,
        ...defaultFileListParams,
      });
    });

    it('makes correct GAPI query for "nameContains" and "nameNotContains"', async () => {
      // @ts-ignore
      const listFilesMock = jest.spyOn(gapi.client.drive.files, 'list');
      const mockResponse = { body: '', result: { files: [{ id: '1', name: 'file1' }] } };
      listFilesMock.mockResolvedValue(mockResponse);

      const plugin = new GoogleDrivePlugin({ clientId: '1234', defaultFolderName: 'foo' });
      const files = await plugin.listGoogleDriveFiles({ type: 'files', nameContains: ['foo', 'bar'] });

      expect(files).toEqual(mockResponse.result.files);
      expect(listFilesMock).toHaveBeenCalledWith({
        q: `mimeType != '${GAPI_FOLDER_MIME_TYPE}' and (name contains 'foo' or name contains 'bar')`,
        ...defaultFileListParams,
      });

      await plugin.listGoogleDriveFiles({ type: 'files', nameContains: ['foo'] });
      expect(listFilesMock).toHaveBeenCalledWith({
        q: `mimeType != '${GAPI_FOLDER_MIME_TYPE}' and (name contains 'foo')`,
        ...defaultFileListParams,
      });

      await plugin.listGoogleDriveFiles({ type: 'files', nameNotContains: ['foo', 'bar'] });
      expect(listFilesMock).toHaveBeenCalledWith({
        q: `mimeType != '${GAPI_FOLDER_MIME_TYPE}' and (not name contains 'foo' and not name contains 'bar')`,
        ...defaultFileListParams,
      });

      await plugin.listGoogleDriveFiles({ type: 'files', nameContains: ['foo'], nameNotContains: ['bar'] });
      expect(listFilesMock).toHaveBeenCalledWith({
        q: `mimeType != '${GAPI_FOLDER_MIME_TYPE}' and (name contains 'foo') and (not name contains 'bar')`,
        ...defaultFileListParams,
      });
    });
  });
});

function stubMockGapiGlobal() {
  // @ts-ignore
  'gapi.client.drive.files'.split('.').reduce((obj: unknown, name) => (obj[name] = {}), window);

  // @ts-ignore
  gapi.client.drive.files.list = () => {};
}
