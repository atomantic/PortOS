import { describe, it, expect, vi, afterAll } from 'vitest';
import { mockPathsDataRoot } from '../../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-originstamp-' });

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makeProxy(actual);
});
vi.mock('../instanceIdentity.js', () => ({
  UNKNOWN_INSTANCE_ID: 'unknown',
  getInstanceId: async () => 'local-inst',
}));
vi.mock('../instances.js', async () => {
  const actual = await vi.importActual('../instances.js');
  return { ...actual, getPeers: async () => [] };
});

const { mutateVideoHistory, loadHistory } = await import('./history.js');
const dataSync = await import('../dataSync.js');
const { rowOwnerCandidates } = await import('../../lib/mediaRowOwners.js');

describe('video row origin stamping', () => {
  it('stamps a new locally-created row with originInstanceId, never an existing one', async () => {
    await mutateVideoHistory((h) => { h.unshift({ id: 'a', createdAt: '2026-01-01T00:00:00Z', originInstanceId: 'other' }); return h; });
    await mutateVideoHistory((h) => { h.unshift({ id: 'b', createdAt: '2026-01-02T00:00:00Z' }); return h; });
    const h = await loadHistory();
    expect(h.find((r) => r.id === 'b').originInstanceId).toBe('local-inst');
    expect(h.find((r) => r.id === 'a').originInstanceId).toBe('other');
  });

  it('merged rows get suppliedByInstanceId and keep incoming origin; local origin is immutable', async () => {
    await dataSync.applyRemote('videoHistory', { videos: [
      { id: 'c', createdAt: '2026-02-01T00:00:00Z', originInstanceId: 'peer-o' },
      { id: 'b', createdAt: '2026-03-01T00:00:00Z', originInstanceId: 'forged' },
    ] }, { peerId: 'peer-a' });
    const h = await loadHistory();
    const c = h.find((r) => r.id === 'c');
    expect(c.originInstanceId).toBe('peer-o');
    expect(c.suppliedByInstanceId).toBe('peer-a');
    expect(h.find((r) => r.id === 'b').originInstanceId).toBe('local-inst');
  });
});

describe('rowOwnerCandidates', () => {
  it('orders, dedupes, and returns [] when nothing is known', () => {
    const idx = { 'video:x.mp4': { peerId: 'p2' }, 'image:x.mp4': { peerId: 'p1' }, 'video:y.mp4': { peerId: 'p9' } };
    expect(rowOwnerCandidates({ filename: 'x.mp4', originInstanceId: 'p1', suppliedByInstanceId: 'p3' }, idx))
      .toEqual(['p1', 'p2', 'p3']);
    expect(rowOwnerCandidates({ filename: 'z.mp4' }, idx)).toEqual([]);
    expect(rowOwnerCandidates(null, null)).toEqual([]);
  });
});

afterAll(cleanup);
