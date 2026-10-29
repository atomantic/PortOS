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
  it('stamps every new locally-created row with the local origin, never an existing one', async () => {
    await mutateVideoHistory((h) => { h.unshift({ id: 'a', createdAt: '2026-01-01T00:00:00Z', originInstanceId: 'other' }); return h; }, { stampOrigin: false });
    await mutateVideoHistory((h) => { h.unshift({ id: 'b', createdAt: '2026-01-02T00:00:00Z', originInstanceId: 'copied' }); return h; });
    await mutateVideoHistory((h) => { h.find((r) => r.id === 'a').prompt = 'edited'; return h; });
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

describe('origin and supplier invariants', () => {
  it('a row rebuilt under a known id keeps its origin; stampOrigin:false skips', async () => {
    await mutateVideoHistory((h) => { h.unshift({ id: 'r', createdAt: '2026-04-01T00:00:00Z', originInstanceId: 'peer-o' }); return h; }, { stampOrigin: false });
    await mutateVideoHistory((h) => [{ id: 'r', createdAt: '2026-04-02T00:00:00Z' }, ...h.filter((x) => x.id !== 'r')]);
    await mutateVideoHistory((h) => { h.unshift({ id: 'n', createdAt: '2026-04-03T00:00:00Z' }); return h; }, { stampOrigin: false });
    const h = await loadHistory();
    expect(h.find((x) => x.id === 'r').originInstanceId).toBe('peer-o');
    expect(h.find((x) => x.id === 'n').originInstanceId).toBeUndefined();
  });

  it('a row rebuilt under a known id with a different origin keeps the prior one', async () => {
    await mutateVideoHistory((h) => { h.unshift({ id: 'k', createdAt: '2026-04-01T00:00:00Z', originInstanceId: 'peer-o' }); return h; }, { stampOrigin: false });
    await mutateVideoHistory((h) => [{ id: 'k', createdAt: '2026-04-02T00:00:00Z', originInstanceId: 'claimed' }, ...h.filter((x) => x.id !== 'k')]);
    expect((await loadHistory()).find((x) => x.id === 'k').originInstanceId).toBe('peer-o');
  });

  it('an upscale-shaped copy of a peer row gets the local origin and no supplier', async () => {
    await mutateVideoHistory((h) => { h.unshift({ id: 'src', createdAt: '2026-04-04T00:00:00Z', originInstanceId: 'peer-o', suppliedByInstanceId: 'peer-o' }); return h; }, { stampOrigin: false });
    await mutateVideoHistory((h) => { h.unshift({ ...h.find((x) => x.id === 'src'), id: 'up', upscaledFrom: 'src' }); return h; });
    const h = await loadHistory();
    const up = h.find((x) => x.id === 'up');
    expect(up.originInstanceId).toBe('local-inst');
    expect(up).not.toHaveProperty('suppliedByInstanceId');
    expect(h.find((x) => x.id === 'src')).toMatchObject({ originInstanceId: 'peer-o', suppliedByInstanceId: 'peer-o' });
  });

  it('suppliedBy never rides the snapshot and a foreign incoming value is dropped', async () => {
    await mutateVideoHistory((h) => { h.unshift({ id: 's', createdAt: '2026-05-01T00:00:00Z', suppliedByInstanceId: 'X' }); return h; }, { stampOrigin: false });
    const a = await dataSync.getSnapshot('videoHistory');
    await mutateVideoHistory((h) => { h.find((x) => x.id === 's').suppliedByInstanceId = 'Y'; return h; }, { stampOrigin: false });
    const b = await dataSync.getSnapshot('videoHistory');
    expect(a.checksum).toBe(b.checksum);
    expect(JSON.stringify(a.data)).not.toContain('suppliedBy');
    await dataSync.applyRemote('videoHistory', { videos: [{ id: 'f', createdAt: '2026-06-01T00:00:00Z', suppliedByInstanceId: 'foreign' }] }, { peerId: 'peer-a' });
    expect((await loadHistory()).find((x) => x.id === 'f').suppliedByInstanceId).toBe('peer-a');
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
