/**
 * #3929 — concurrent standalone media-library sweeps from MULTIPLE full-sync
 * peers must not race on the same destination asset file (nor stack whole-index
 * reconciles). The per-peer `inflightPulls` guard is keyed by peer id, so two
 * peers advertising the same filename both pass it; the destination-keyed
 * `assetWriteQueue` is what serializes them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot = mkdtempSync(join(tmpdir(), 'portos-asset-race-boot-'));

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});

const peers = [];
vi.mock('../instances.js', () => ({
  getPeers: vi.fn(async () => peers),
}));

vi.mock('../../lib/peerHttpClient.js', () => ({ peerFetch: vi.fn() }));

const { peerFetch } = await import('../../lib/peerHttpClient.js');
const { pullMissingAssetsFromPeer, assetWriteQueue } = await import('./peerSyncAssets.js');
const { syncMediaLibraryWithAllPeers } = await import('./peerMediaLibrarySync.js');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Minimal fetch Response stand-in: peerSyncAssets requires a trustworthy
// content-length before it will buffer a body.
const mkRes = (buffer) => ({
  ok: true,
  headers: {
    has: (h) => h === 'content-length',
    get: (h) => (h === 'content-length' ? String(buffer.length) : null),
  },
  arrayBuffer: async () => buffer,
});

// Distinct TEST-NET-1 addresses so a test can tell the two peers' fetch URLs apart.
const mkPeer = (id, address) => ({ instanceId: id, name: id, address, port: 5555, fullSync: true });

function setPeers(...entries) {
  peers.length = 0;
  peers.push(...entries);
}

// `audio` is the simplest kind end-to-end: no gen-params sidecar fetch (images)
// and no local thumbnail regeneration (videos), so every peerFetch call in these
// tests is an asset-byte pull.
const audioEntry = (filename, buffer) => ({ filename, kind: 'audio', sha256: sha(buffer) });

/** Wrap peerFetch so the test can observe how many byte-pulls overlap. */
function trackingFetch(bodyFor, delayMs = 20) {
  const state = { inFlight: 0, maxInFlight: 0, urls: [] };
  vi.mocked(peerFetch).mockImplementation(async (url) => {
    state.urls.push(url);
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await sleep(delayMs);
    state.inFlight -= 1;
    return mkRes(bodyFor(url));
  });
  return state;
}

describe('#3929 — cross-peer asset pull serialization', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-asset-race-'));
    assetWriteQueue.clear();
    vi.mocked(peerFetch).mockReset();
    setPeers(mkPeer('peer-a', '192.0.2.10'), mkPeer('peer-b', '192.0.2.11'));
  });
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  // Bypass probe: the harness CAN observe overlap — two pulls for DIFFERENT
  // destinations do run concurrently, so `maxInFlight === 1` in the tests below
  // is the queue working, not the instrumentation failing to see a second call.
  it('leaves pulls for DIFFERENT filenames concurrent', async () => {
    const a = Buffer.from('alpha-bytes');
    const b = Buffer.from('beta-bytes-longer');
    const state = trackingFetch((url) => (url.endsWith('a.mp3') ? a : b));
    await Promise.all([
      pullMissingAssetsFromPeer('peer-a', [audioEntry('a.mp3', a)]),
      pullMissingAssetsFromPeer('peer-b', [audioEntry('b.mp3', b)]),
    ]);
    expect(state.maxInFlight).toBe(2);
  });

  it('serializes two peers pulling the SAME filename and skips the duplicate download', async () => {
    const bytes = Buffer.from('shared-library-audio');
    const entry = audioEntry('shared.mp3', bytes);
    const state = trackingFetch(() => bytes);
    await Promise.all([
      pullMissingAssetsFromPeer('peer-a', [entry]),
      pullMissingAssetsFromPeer('peer-b', [entry]),
    ]);
    // Never two writers on one destination path...
    expect(state.maxInFlight).toBe(1);
    // ...and the second peer's turn found the bytes already correct, so it
    // re-hashed instead of re-downloading.
    expect(state.urls).toHaveLength(1);
    expect(readFileSync(join(tempRoot, 'audio', 'shared.mp3'))).toEqual(bytes);
  });

  it('serializes even when the two peers advertise DIFFERENT bytes for one filename', async () => {
    // Distinct lengths so a torn/interleaved write is detectable: the final file
    // must be exactly one complete version, never a blend or a truncation.
    const older = Buffer.from('older-render');
    const newer = Buffer.from('newer-render-with-more-bytes');
    // Each peer serves its OWN version — the peers sit on distinct addresses, so
    // the requested URL identifies which one is being pulled.
    const state = trackingFetch((url) => (url.includes('192.0.2.11') ? newer : older));
    await Promise.all([
      pullMissingAssetsFromPeer('peer-a', [audioEntry('contested.mp3', older)]),
      pullMissingAssetsFromPeer('peer-b', [audioEntry('contested.mp3', newer)]),
    ]);
    expect(state.maxInFlight).toBe(1);
    const onDisk = readFileSync(join(tempRoot, 'audio', 'contested.mp3'));
    expect([older.toString(), newer.toString()]).toContain(onDisk.toString());
  });

  it('skips the pull entirely when local bytes already match the advertised hash', async () => {
    const bytes = Buffer.from('already-here');
    mkdirSync(join(tempRoot, 'audio'), { recursive: true });
    writeFileSync(join(tempRoot, 'audio', 'present.mp3'), bytes);
    const state = trackingFetch(() => bytes);
    await pullMissingAssetsFromPeer('peer-a', [audioEntry('present.mp3', bytes)]);
    expect(state.urls).toHaveLength(0);
  });
});

describe('#3929 — syncMediaLibraryWithAllPeers global re-entrancy guard', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-sweep-race-'));
    vi.mocked(peerFetch).mockReset();
    setPeers(mkPeer('peer-a', '192.0.2.10'), mkPeer('peer-b', '192.0.2.11'));
  });
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('refuses a second all-peers sweep while one is still running', async () => {
    // A manifest fetch that outlives the tick — the exact condition that would
    // otherwise let tick N+1 start peer B while tick N is mid-pull on peer A.
    vi.mocked(peerFetch).mockImplementation(async () => {
      await sleep(30);
      return { ok: false, headers: { has: () => false, get: () => null } };
    });
    const first = syncMediaLibraryWithAllPeers();
    const second = await syncMediaLibraryWithAllPeers();
    expect(second).toEqual({ peers: 0, skipped: 'in-flight' });
    expect(await first).toEqual({ peers: 2 });
    // Guard releases: a later tick sweeps normally.
    expect(await syncMediaLibraryWithAllPeers()).toEqual({ peers: 2 });
  });
});
