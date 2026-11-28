/**
 * #3929 — concurrent standalone media-library sweeps from MULTIPLE full-sync
 * peers must not race on the same destination asset file (nor stack whole-index
 * reconciles). The per-peer `inflightPulls` guard is keyed by peer id, so two
 * peers advertising the same filename both pass it; the destination-keyed
 * `assetWriteQueue` is what serializes them.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot = mkdtempSync(join(tmpdir(), 'portos-asset-race-boot-'));
const bootRoot = tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy({ ...actual, sha256File: vi.fn(actual.sha256File) }, { dataRoot: () => tempRoot });
});

const peers = [];
vi.mock('../instances.js', () => ({
  getPeers: vi.fn(async () => peers),
}));

vi.mock('../../lib/peerHttpClient.js', async (importOriginal) => ({ ...(await importOriginal()), peerFetch: vi.fn() }));

const { sha256File } = await import('../../lib/fileUtils.js');
const { peerFetch } = await import('../../lib/peerHttpClient.js');
const { diffAssetManifestAgainstLocal, pullMissingAssetsFromPeer, assetWriteQueue } = await import('./peerSyncAssets.js');
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

  it('pools up to 4 concurrent pulls for distinct filenames from one peer', async () => {
    const entries = Array.from({ length: 6 }, (_, i) => {
      const buf = Buffer.from(`track-${i}-bytes`);
      return { entry: audioEntry(`track-${i}.mp3`, buf), buf };
    });
    const byName = new Map(entries.map(({ entry, buf }) => [entry.filename, buf]));
    const state = trackingFetch((url) => byName.get(url.split('/').pop()));
    await pullMissingAssetsFromPeer('peer-a', entries.map(({ entry }) => entry));
    expect(state.maxInFlight).toBe(4);
    expect(state.urls).toHaveLength(6);
    for (const { entry, buf } of entries) {
      expect(readFileSync(join(tempRoot, 'audio', entry.filename))).toEqual(buf);
    }
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

describe('diffAssetManifestAgainstLocal — flat-asset hash caching and bounded concurrency', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-diff-cache-'));
    vi.mocked(sha256File).mockClear();
  });
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('caches flat-asset SHA-256 across repeated diffs and invalidates on file change', async () => {
    mkdirSync(join(tempRoot, 'audio'), { recursive: true });
    const aPath = join(tempRoot, 'audio', 'cached-a.mp3');
    const bPath = join(tempRoot, 'audio', 'cached-b.mp3');
    const aBytes = Buffer.from('audio-alpha-v1');
    const bBytes = Buffer.from('audio-beta-v1');
    writeFileSync(aPath, aBytes);
    writeFileSync(bPath, bBytes);

    const manifest = [
      audioEntry('cached-a.mp3', aBytes),
      audioEntry('cached-b.mp3', bBytes),
    ];

    expect(await diffAssetManifestAgainstLocal(manifest)).toEqual([]);
    expect(sha256File).toHaveBeenCalledTimes(2);

    // Second diff (e.g. post-pull re-diff) reuses cached hashes with zero extra sha256File calls.
    expect(await diffAssetManifestAgainstLocal(manifest)).toEqual([]);
    expect(sha256File).toHaveBeenCalledTimes(2);

    // Replacing cached-a.mp3 with different bytes invalidates its cache entry only.
    const aBytesV2 = Buffer.from('audio-alpha-v2-longer');
    writeFileSync(aPath, aBytesV2);
    const missing = await diffAssetManifestAgainstLocal(manifest);
    expect(missing).toEqual([manifest[0]]);
    expect(sha256File).toHaveBeenCalledTimes(3);
  });

  it('bounds concurrent flat-asset hashing and preserves manifest order', async () => {
    mkdirSync(join(tempRoot, 'audio'), { recursive: true });
    const manifest = [];
    for (let i = 0; i < 12; i++) {
      const name = `clip-${String(i).padStart(2, '0')}.mp3`;
      writeFileSync(join(tempRoot, 'audio', name), Buffer.from(`local-${i}`));
      manifest.push(audioEntry(name, Buffer.from(`remote-${i}`)));
    }

    const actual = await vi.importActual('../../lib/fileUtils.js');
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(sha256File).mockImplementation(async (p) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(15);
      inFlight -= 1;
      return actual.sha256File(p);
    });

    try {
      const missing = await diffAssetManifestAgainstLocal(manifest);
      expect(missing.map((e) => e.filename)).toEqual(manifest.map((e) => e.filename));
      expect(maxInFlight).toBe(8);
    } finally {
      vi.mocked(sha256File).mockImplementation(actual.sha256File);
    }
  });
});

// bootRoot is the module-scope placeholder mkdtemp'd before any hook runs
// (needed so the mocked PATHS.data resolves before the dynamic import below
// evaluates) — once the first describe block's beforeEach reassigns
// `tempRoot`, nothing else references it. Remove it once here (#9032).
afterAll(() => {
  rmSync(bootRoot, { recursive: true, force: true });
});
