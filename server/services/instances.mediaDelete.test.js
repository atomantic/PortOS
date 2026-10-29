import { describe, it, expect, vi } from 'vitest';

vi.unmock('./instances.js');
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  dataPath: (name) => `/mock/data/${name}`,
  readJSONFile: vi.fn(),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  PATHS: { data: '/mock/data' }
}));
vi.mock('./instanceEvents.js', () => ({ instanceEvents: { emit: vi.fn() } }));
vi.mock('./peerSocketRelay.js', () => ({ connectToPeer: vi.fn(), disconnectFromPeer: vi.fn() }));
vi.mock('../lib/asyncMutex.js', () => ({ createMutex: () => (fn) => fn() }));

import { readJSONFile } from '../lib/fileUtils.js';
import { addPeer, updatePeer, peerMayDeleteMedia } from './instances.js';

describe('media.delete peer capability', () => {
  it('new peers default to allowed', async () => {
    let store = { self: { instanceId: 'self' }, peers: [] };
    readJSONFile.mockImplementation(async () => structuredClone(store));
    const { atomicWrite } = await import('../lib/fileUtils.js');
    atomicWrite.mockImplementation(async (_p, d) => { store = structuredClone(d); });
    const peer = await addPeer({ address: '192.0.2.11' });
    expect(peer.mediaDeleteAllowed).toBe(true);
    expect(peerMayDeleteMedia(peer)).toBe(true);
    expect(peerMayDeleteMedia({})).toBe(true);
  });

  it('explicit false refuses', async () => {
    let store = { self: { instanceId: 'self' }, peers: [{ id: 'p1', address: '192.0.2.11', port: 5555, mediaDeleteAllowed: true }] };
    readJSONFile.mockImplementation(async () => structuredClone(store));
    const { atomicWrite } = await import('../lib/fileUtils.js');
    atomicWrite.mockImplementation(async (_p, d) => { store = structuredClone(d); });
    const updated = await updatePeer('p1', { mediaDeleteAllowed: false }, { probe: false });
    expect(updated.mediaDeleteAllowed).toBe(false);
    expect(peerMayDeleteMedia(updated)).toBe(false);
  });
});
