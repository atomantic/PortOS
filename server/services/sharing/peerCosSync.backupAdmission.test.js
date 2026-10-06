import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const state = vi.hoisted(() => ({ beforeDownload: null, beforeWrite: null, staged: null, failIndex: false, manifestHash: '' }));
const root = await mkdtemp(join(tmpdir(), 'peer-cos-publication-'));
const agentsDir = join(root, 'agents');
const indexPath = join(agentsDir, 'index.json');
const date = '2026-01-01';
const agentId = 'agent-example';
const peer = { instanceId: 'peer-example', name: 'Example peer', address: '192.0.2.10', port: 5555, fullSync: true };
const files = { 'metadata.json': '{"id":"agent-example","status":"completed"}', 'output.txt': 'Example output', 'prompt.txt': 'Example prompt' };
const sha = value => createHash('sha256').update(value).digest('hex');
const entries = Object.entries(files).map(([file, content]) => ({ date, agentId, file, sha256: sha(content) }));

vi.mock('../../lib/fileUtils.js', async original => {
  const actual = await original();
  return { ...actual, PATHS: { ...actual.PATHS, cos: root }, atomicWrite: async (path, data) => {
    await state.beforeWrite?.(path);
    await actual.atomicWrite(path, data);
    if (!path.startsWith(root)) state.staged?.(path);
  } };
});
vi.mock('../cosState.js', () => ({ AGENTS_DIR: agentsDir }));
vi.mock('../instances.js', () => ({ getPeers: async () => [peer] }));
vi.mock('./peerSyncShared.js', () => ({ findPeerById: async () => peer, FORCE_REVALIDATE_EVERY: 50, peerSyncEvents: new EventEmitter() }));
vi.mock('./peerSyncAssets.js', () => ({ inflightPulls: new Set(), inflightKey: (...parts) => parts.join(':'), ASSET_PULL_TIMEOUT_MS: 1000,
  fetchCappedAssetBuffer: async (_peer, url) => {
    const filename = new URL(url).searchParams.get('file');
    await state.beforeDownload?.(filename);
    return Buffer.from(files[filename]);
  } }));
vi.mock('../../lib/peerHttpClient.js', () => ({ peerFetch: async () => ({ ok: true }),
  readPeerBody: async () => ({ schemaVersion: 1, manifestHash: state.manifestHash, entries }) }));
vi.mock('../../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission() {} }));
vi.mock('../cosAgentIndex.js', async original => {
  const actual = await original();
  return { ...actual, addAgentArchivesToIndex: async pairs => {
    if (state.failIndex) throw new Error('Example index unavailable');
    return actual.addAgentArchivesToIndex(pairs);
  } };
});

const { syncCosHistoryFromPeer } = await import('./peerCosSync.js');
const { loadAgentIndex } = await import('../cosAgentIndex.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function readIndex() { return JSON.parse(await readFile(indexPath, 'utf8')); }
async function assertComplete() {
  expect(await readIndex()).toEqual({ [agentId]: date });
  for (const [filename, content] of Object.entries(files)) {
    expect(await readFile(join(agentsDir, date, agentId, filename), 'utf8')).toBe(content);
  }
}
async function seedArchive() {
  await mkdir(join(agentsDir, date, agentId), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(agentsDir, date, agentId, name), body);
}

let caseNumber = 0;
beforeEach(async () => {
  state.beforeDownload = null; state.beforeWrite = null; state.staged = null; state.failIndex = false;
  state.manifestHash = sha(`case-${++caseNumber}`);
  await rm(agentsDir, { recursive: true, force: true }); await mkdir(agentsDir);
  await writeFile(indexPath, '{}');
  (await loadAgentIndex()).clear();
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('peer CoS archive bytes and primary index under a backup cut', () => {
  it('downloads outside admission and keeps staged bytes out of a held snapshot', async () => {
    const downloading = deferred(); const finishDownload = deferred(); const staged = deferred();
    const scratchFiles = [];
    state.beforeDownload = async name => { if (name === 'metadata.json') { downloading.resolve(); await finishDownload.promise; } };
    state.staged = path => { scratchFiles.push(path); if (path.endsWith('prompt.txt')) staged.resolve(); };
    const importing = syncCosHistoryFromPeer(peer);
    await downloading.promise;
    const release = await acquireBackupSnapshotCut();
    try {
      finishDownload.resolve(); await staged.promise; await turn();
      expect(await readIndex()).toEqual({});
      expect(existsSync(join(agentsDir, date, agentId))).toBe(false);
    } finally { release(); }
    expect(await importing).toEqual({ pulled: 3, missing: 0 });
    await assertComplete();
    expect(scratchFiles).toHaveLength(3);
    expect(scratchFiles.some(path => existsSync(path))).toBe(false);
  });

  it('drains final archive writes through the durable primary index commit', async () => {
    const reached = deferred(); const finish = deferred();
    state.beforeWrite = async path => { if (path === indexPath) { reached.resolve(); await finish.promise; } };
    const importing = syncCosHistoryFromPeer(peer);
    await reached.promise;
    expect(await readFile(join(agentsDir, date, agentId, 'output.txt'), 'utf8')).toBe(files['output.txt']);
    expect(await readIndex()).toEqual({});
    let acquired = false;
    const cut = acquireBackupSnapshotCut().then(release => { acquired = true; return release; });
    try { await turn(); expect(acquired, 'snapshot must not split peer archive files from their index').toBe(false); }
    finally { finish.resolve(); }
    await importing;
    const release = await cut;
    try { await assertComplete(); } finally { release(); }
  });

  it('holds present-but-unindexed recovery outside a cut and retries a failed index merge', async () => {
    await seedArchive();
    state.failIndex = true;
    await syncCosHistoryFromPeer(peer);
    expect(await readIndex()).toEqual({});
    state.failIndex = false;
    const release = await acquireBackupSnapshotCut();
    const recovering = syncCosHistoryFromPeer(peer);
    try { await turn(); expect(await readIndex()).toEqual({}); }
    finally { release(); }
    expect(await recovering).toEqual({ pulled: 0 });
    await assertComplete();
  });
});
