import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-datasync-vhosted-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

const peers = vi.hoisted(() => ({ list: [] }));
vi.mock('./instances.js', async () => {
  const actual = await vi.importActual('./instances.js');
  return { ...actual, getPeers: async () => peers.list };
});
const markHosted = vi.hoisted(() => vi.fn(async () => 1));
vi.mock('./peerHostedMedia.js', async () => {
  const actual = await vi.importActual('./peerHostedMedia.js');
  return { ...actual, markHosted };
});

const dataSync = await import('./dataSync.js');

const videos = [{ id: 'v1', filename: 'v1.mp4', createdAt: '2026-05-22T00:00:00Z' }, { id: 'v2', createdAt: '2026-05-22T00:00:00Z' }];

describe('dataSync videoHistory — host-mode peers', () => {
  beforeEach(() => { markHosted.mockClear(); });

  it('indexes a host-mode sender\'s video files as peer-hosted', async () => {
    peers.list = [{ instanceId: 'peer-a', mediaSyncMode: 'host' }];
    await dataSync.applyRemote('videoHistory', { videos }, { peerId: 'peer-a' });
    expect(markHosted).toHaveBeenCalledWith('peer-a', [{ kind: 'video', filename: 'v1.mp4' }]);
  });

  it('does not index when the sender copies bytes', async () => {
    peers.list = [{ instanceId: 'peer-a', mediaSyncMode: 'copy' }];
    await dataSync.applyRemote('videoHistory', { videos }, { peerId: 'peer-a' });
    expect(markHosted).not.toHaveBeenCalled();
  });
});

afterAll(cleanup);
