import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const settings = { videoGen: { runway: { apiKey: 'rk' }, fal: { apiKey: 'fk' } }, imageGen: { runway: {}, fal: {} } };
const history = [];
const sidecars = new Map();

vi.mock('./settings.js', () => ({ getSettings: async () => settings }));
vi.mock('./videoGen/history.js', () => ({
  getHistoryItem: async (id) => history.find((h) => h.id === id) || null,
  mutateVideoHistory: async (fn) => fn(history),
}));
const emitted = [];
vi.mock('./peerSyncEventBus.js', () => ({ emitMediaHistoryChanged: (event) => emitted.push(event) }));
vi.mock('./imageGen/sidecarStore.js', () => ({
  readImageSidecar: async (filename) => ({ metadata: sidecars.get(filename) || {} }),
  editImageSidecar: async (filename, fn) => fn(sidecars.get(filename)),
}));

const { deleteVideoHostedCopy, deleteImageHostedCopy, autoDeleteHostedCopy } = await import('./hostedRenderRemoteDelete.js');

describe('hosted render remote delete', () => {
  let fetchMock;
  beforeEach(() => {
    history.length = 0;
    sidecars.clear();
    emitted.length = 0;
    settings.imageGen = { runway: {}, fal: {} };
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ cdn_delete_results: [{ link: 'x', exception: null }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('deletes a Runway task with the Runway key and stamps the video record', async () => {
    history.push({ id: 'v1', runwayTaskId: 'task-1' });
    const result = await deleteVideoHostedCopy('runway', 'v1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.dev.runwayml.com/v1/tasks/task-1');
    expect(init).toMatchObject({ method: 'DELETE', headers: expect.objectContaining({ Authorization: 'Bearer rk' }) });
    expect(history[0].runwayDeletedAt).toBe(result.deletedAt);
    await vi.waitFor(() => expect(emitted).toEqual([{ kind: 'video', op: 'upsert', ids: ['v1'] }]));
  });

  it('deletes fal.ai request payloads and stamps the image sidecar', async () => {
    sidecars.set('a.png', { falRequestId: 'req-9' });
    await deleteImageHostedCopy('fal', 'a.png');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.fal.ai/v1/models/requests/req-9/payloads');
    expect(init.headers.Authorization).toBe('Key fk');
    expect(sidecars.get('a.png').falDeletedAt).toEqual(expect.any(String));
  });

  it('refuses a render with no recorded hosted request, and leaves a failed delete unstamped', async () => {
    history.push({ id: 'v2' }, { id: 'v3', falRequestId: 'req-3' });
    await expect(deleteVideoHostedCopy('fal', 'v2')).rejects.toMatchObject({ code: 'NO_HOSTED_REQUEST' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ cdn_delete_results: [{ link: 'x', exception: 'boom' }] }), { status: 200 }));
    await expect(deleteVideoHostedCopy('fal', 'v3')).rejects.toMatchObject({ code: 'FAL_DELETE_FAILED' });
    expect(history[1].falDeletedAt).toBeUndefined();
    // A 200 whose body cannot be read proves nothing about the files, so it is not a delete either.
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    await expect(deleteVideoHostedCopy('fal', 'v3')).rejects.toMatchObject({ code: 'FAL_DELETE_FAILED' });
    expect(history[1].falDeletedAt).toBeUndefined();
  });

  it('auto-deletes only when the provider toggle is on, and never throws', async () => {
    history.push({ id: 'v4', runwayTaskId: 'task-4' });
    expect(await autoDeleteHostedCopy('runway', 'video', 'v4')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    settings.imageGen.runway.deleteAfterDownload = true;
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    expect(await autoDeleteHostedCopy('runway', 'video', 'v4')).toBe(false);
    expect(history[0].runwayDeletedAt).toBeUndefined();
    expect(await autoDeleteHostedCopy('runway', 'video', 'v4')).toBe(true);
    expect(history[0].runwayDeletedAt).toEqual(expect.any(String));
  });
});
