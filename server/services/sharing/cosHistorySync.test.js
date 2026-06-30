import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

// Completed-agent CoS history federation (#1650). We exercise peerSync.js's
// cos-history functions against a tmpdir-redirected PATHS.cos, stubbing the
// network (peerFetch) and the peer registry (instances). cosAgents.js is mocked
// so the receiver's index merge is a spy — it must NEVER touch the real
// data/cos/agents index. The heavy record-graph modules are mocked exactly as
// peerSync.test.js does, purely so importing peerSync.js stays cheap + offline.

import { PATHS } from '../../lib/fileUtils.js';

vi.mock('../instances.js', () => ({
  UNKNOWN_INSTANCE_ID: 'unknown',
  DEFAULT_SYNC_CATEGORIES: {},
  getInstanceId: vi.fn().mockResolvedValue('test-instance'),
  getPeers: vi.fn().mockResolvedValue([]),
  enqueueReciprocalSync: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../universeBuilder.js', async () => ({ getUniverse: vi.fn(), mergeUniversesFromSync: vi.fn(), listUniverses: vi.fn() }));
vi.mock('../pipeline/series.js', async () => ({ getSeries: vi.fn(), mergeSeriesFromSync: vi.fn(), listSeries: vi.fn() }));
vi.mock('../pipeline/issues.js', async () => ({ listIssues: vi.fn(), mergeIssuesFromSync: vi.fn() }));
vi.mock('../pipeline/manuscriptReview.js', async () => ({ getReview: vi.fn(), mergeReviewFromSync: vi.fn() }));
vi.mock('../pipeline/reverseOutline.js', async () => ({ getStoredOutline: vi.fn(), mergeOutlineFromSync: vi.fn() }));
vi.mock('../mediaCollections.js', async () => ({
  getCollection: vi.fn(), listCollections: vi.fn(), findCollectionByUniverseId: vi.fn(),
  findCollectionBySeriesId: vi.fn(), mergeMediaCollectionsFromSync: vi.fn(),
}));
vi.mock('../mediaAssetIndex/index.js', () => ({ reconcileMediaAssets: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/peerHttpClient.js', async () => ({ peerFetch: vi.fn() }));
// cosAgents is dynamic-imported by the receiver to merge the agentId→date index.
// Spy it so the merge is observable AND can't write the real data/cos index.
vi.mock('../cosAgents.js', () => ({ addAgentArchivesToIndex: vi.fn().mockResolvedValue(0) }));

import {
  buildCosHistoryManifest,
  diffCosHistoryManifestAgainstLocal,
  syncCosHistoryFromPeer,
} from './peerSync.js';
import { getPeers } from '../instances.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { addAgentArchivesToIndex } from '../cosAgents.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

function byteRes(content) {
  const buf = Buffer.from(content);
  return {
    ok: true,
    headers: new Headers({ 'content-length': String(buf.length) }),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}
function manifestRes(obj) {
  return { ok: true, headers: { get: () => null }, json: async () => obj };
}

const PEER = { instanceId: 'peer-1', name: 'P1', address: '10.0.0.2', port: 5555, fullSync: true, enabled: true };

let tmp;
let originalCos;

beforeEach(async () => {
  originalCos = PATHS.cos;
  tmp = join(tmpdir(), `portos-cos-history-${process.pid}-${Math.random().toString(36).slice(2)}`);
  PATHS.cos = tmp;
  await mkdir(join(tmp, 'agents'), { recursive: true });
  vi.mocked(peerFetch).mockReset();
  vi.mocked(getPeers).mockResolvedValue([PEER]);
  vi.mocked(addAgentArchivesToIndex).mockClear();
});

afterEach(async () => {
  PATHS.cos = originalCos;
  await rm(tmp, { recursive: true, force: true });
});

async function seedArchive(date, agentId, files) {
  const dir = join(tmp, 'agents', date, agentId);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
}

describe('buildCosHistoryManifest', () => {
  it('hashes each archive file, skips index.json + flat running dirs, is deterministic', async () => {
    await seedArchive('2026-06-20', 'agent-abc', {
      'metadata.json': '{"id":"agent-abc"}',
      'output.txt': 'line1\nline2\n',
      'prompt.txt': 'do the thing',
    });
    // Noise that must be excluded: the type-level index, and a flat (running) dir.
    await writeFile(join(tmp, 'agents', 'index.json'), '{"agent-abc":"2026-06-20"}');
    await mkdir(join(tmp, 'agents', 'agent-running'), { recursive: true });
    await writeFile(join(tmp, 'agents', 'agent-running', 'metadata.json'), '{}');

    const m = await buildCosHistoryManifest();
    expect(m.schemaVersion).toBe(1);
    expect(m.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(m.entries).toHaveLength(3);
    const files = m.entries.map((e) => e.file).sort();
    expect(files).toEqual(['metadata.json', 'output.txt', 'prompt.txt']);
    expect(m.entries.every((e) => e.date === '2026-06-20' && e.agentId === 'agent-abc')).toBe(true);
    expect(m.entries.find((e) => e.file === 'output.txt').sha256).toBe(sha('line1\nline2\n'));
    // Deterministic: a second build over the same disk yields the same hash.
    const again = await buildCosHistoryManifest();
    expect(again.manifestHash).toBe(m.manifestHash);
  });

  it('returns an empty manifest when no archives exist', async () => {
    const m = await buildCosHistoryManifest();
    expect(m.entries).toHaveLength(0);
    expect(m.schemaVersion).toBe(1);
  });
});

describe('diffCosHistoryManifestAgainstLocal', () => {
  it('flags absent + hash-mismatched files, leaves present-matching alone', async () => {
    await seedArchive('2026-06-20', 'agent-abc', { 'metadata.json': 'GOOD' });
    const entries = [
      { date: '2026-06-20', agentId: 'agent-abc', file: 'metadata.json', sha256: sha('GOOD') }, // present+match
      { date: '2026-06-20', agentId: 'agent-abc', file: 'output.txt', sha256: sha('B') },        // absent
    ];
    const missing = await diffCosHistoryManifestAgainstLocal(entries);
    expect(missing.map((e) => e.file)).toEqual(['output.txt']);

    // A locally-present file whose hash differs is also missing.
    const mismatch = await diffCosHistoryManifestAgainstLocal([
      { date: '2026-06-20', agentId: 'agent-abc', file: 'metadata.json', sha256: sha('STALE') },
    ]);
    expect(mismatch).toHaveLength(1);
  });

  it('silently rejects path-traversal segments before any FS op', async () => {
    const evil = [
      { date: '../../etc', agentId: 'agent-abc', file: 'metadata.json', sha256: sha('x') },
      { date: '2026-06-20', agentId: '../../secrets', file: 'metadata.json', sha256: sha('x') },
      { date: '2026-06-20', agentId: 'agent-abc', file: '../../../etc/passwd', sha256: sha('x') },
    ];
    expect(await diffCosHistoryManifestAgainstLocal(evil)).toEqual([]);
  });
});

describe('syncCosHistoryFromPeer', () => {
  it('skips a non-full-sync peer (no network)', async () => {
    const r = await syncCosHistoryFromPeer({ ...PEER, fullSync: false });
    expect(r).toEqual({ pulled: 0, skipped: 'not-fullsync' });
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('gently skips a sender whose manifest schema is ahead', async () => {
    vi.mocked(peerFetch).mockResolvedValue(manifestRes({ schemaVersion: 999, manifestHash: sha('x'), entries: [] }));
    const r = await syncCosHistoryFromPeer(PEER);
    expect(r).toEqual({ pulled: 0, skipped: 'schema-ahead' });
  });

  it('pulls missing archive files, writes them, and merges the index', async () => {
    const meta = '{"id":"agent-abc"}';
    const out = 'transcript\n';
    const prompt = 'sys prompt';
    const entries = [
      { date: '2026-06-20', agentId: 'agent-abc', file: 'metadata.json', sha256: sha(meta) },
      { date: '2026-06-20', agentId: 'agent-abc', file: 'output.txt', sha256: sha(out) },
      { date: '2026-06-20', agentId: 'agent-abc', file: 'prompt.txt', sha256: sha(prompt) },
    ];
    const byFile = { 'metadata.json': meta, 'output.txt': out, 'prompt.txt': prompt };
    vi.mocked(peerFetch).mockImplementation(async (url) => {
      if (url.includes('cos-history-manifest')) {
        return manifestRes({ schemaVersion: 1, manifestHash: sha('m'), entries });
      }
      const file = decodeURIComponent(url.match(/file=([^&]+)/)[1]);
      return byteRes(byFile[file]);
    });

    const r = await syncCosHistoryFromPeer(PEER);
    expect(r).toEqual({ pulled: 3, missing: 0 });
    const dir = join(tmp, 'agents', '2026-06-20', 'agent-abc');
    expect(existsSync(join(dir, 'metadata.json'))).toBe(true);
    expect(existsSync(join(dir, 'output.txt'))).toBe(true);
    expect(existsSync(join(dir, 'prompt.txt'))).toBe(true);
    // Index merge fired with the landed (date, agentId) pairs.
    expect(addAgentArchivesToIndex).toHaveBeenCalledTimes(1);
    const pairs = vi.mocked(addAgentArchivesToIndex).mock.calls[0][0];
    expect(pairs).toContainEqual({ date: '2026-06-20', agentId: 'agent-abc' });
  });

  it('reconciles the index from the manifest even when every file is already present (crash-recovery)', async () => {
    // Simulate a prior sweep that landed the bytes but never persisted the index.
    const meta = '{"id":"agent-abc"}';
    await seedArchive('2026-06-20', 'agent-abc', { 'metadata.json': meta });
    const entries = [{ date: '2026-06-20', agentId: 'agent-abc', file: 'metadata.json', sha256: sha(meta) }];
    vi.mocked(peerFetch).mockResolvedValue(manifestRes({ schemaVersion: 1, manifestHash: sha('present'), entries }));

    const r = await syncCosHistoryFromPeer(PEER);
    expect(r).toEqual({ pulled: 0 }); // nothing to pull — but the index must still be repaired
    expect(addAgentArchivesToIndex).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addAgentArchivesToIndex).mock.calls[0][0]).toContainEqual({ date: '2026-06-20', agentId: 'agent-abc' });
    // No byte route should have been hit — everything was already on disk.
    expect(vi.mocked(peerFetch).mock.calls.every(([u]) => u.includes('cos-history-manifest'))).toBe(true);
  });

  it('withholds the manifest hash on a partial pull (corrupt byte) so it retries', async () => {
    const meta = 'META';
    const out = 'OUT';
    const entries = [
      { date: '2026-06-20', agentId: 'agent-abc', file: 'metadata.json', sha256: sha(meta) },
      { date: '2026-06-20', agentId: 'agent-abc', file: 'output.txt', sha256: sha(out) },
    ];
    vi.mocked(peerFetch).mockImplementation(async (url) => {
      if (url.includes('cos-history-manifest')) {
        return manifestRes({ schemaVersion: 1, manifestHash: sha('m2'), entries });
      }
      const file = decodeURIComponent(url.match(/file=([^&]+)/)[1]);
      // output.txt arrives corrupted → hash mismatch → discarded → stays missing.
      return byteRes(file === 'output.txt' ? 'CORRUPT' : meta);
    });

    const first = await syncCosHistoryFromPeer(PEER);
    expect(first).toEqual({ pulled: 1, missing: 1 });
    expect(existsSync(join(tmp, 'agents', '2026-06-20', 'agent-abc', 'metadata.json'))).toBe(true);
    expect(existsSync(join(tmp, 'agents', '2026-06-20', 'agent-abc', 'output.txt'))).toBe(false);

    // Hash was NOT recorded, so a second identical sweep re-fetches the manifest
    // (not short-circuited as 'unchanged') and re-attempts the still-missing file.
    vi.mocked(peerFetch).mockClear();
    await syncCosHistoryFromPeer(PEER);
    const fetchedManifest = vi.mocked(peerFetch).mock.calls.some(([u]) => u.includes('cos-history-manifest'));
    expect(fetchedManifest).toBe(true);
  });
});
