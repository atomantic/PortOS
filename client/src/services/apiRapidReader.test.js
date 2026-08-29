import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./apiCore.js', () => ({
  request: vi.fn(),
}));

let request;
let api;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  api = await import('./apiRapidReader.js');
  request.mockReset();
  request.mockResolvedValue({});
});

describe('apiRapidReader', () => {
  it('lists shelf metadata and passes request options through', async () => {
    await api.listRapidReaderLibrary({ silent: true });
    expect(request).toHaveBeenCalledWith('/rapid-reader/library', { silent: true });
  });

  it('encodes the id when loading or deleting one entry', async () => {
    await api.getRapidReaderLibraryEntry('shelf/1', { silent: true });
    expect(request).toHaveBeenCalledWith('/rapid-reader/library/shelf%2F1', { silent: true });

    await api.deleteRapidReaderLibraryEntry('shelf/1', { silent: true });
    expect(request).toHaveBeenCalledWith('/rapid-reader/library/shelf%2F1', { method: 'DELETE', silent: true });
  });

  it('posts a pasted entry to the collection', async () => {
    await api.createRapidReaderLibraryEntry({ title: 'Notes', text: 'alpha' }, { silent: true });
    expect(request).toHaveBeenCalledWith('/rapid-reader/library', {
      method: 'POST',
      body: JSON.stringify({ title: 'Notes', text: 'alpha' }),
      silent: true,
    });
  });

  it('posts a URL import to the dedicated fetch lane, not the id lane', async () => {
    await api.fetchRapidReaderLibraryEntry({ url: 'https://example.com/a' }, { silent: true });
    expect(request).toHaveBeenCalledWith('/rapid-reader/library/fetch', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/a' }),
      silent: true,
    });
  });
});
