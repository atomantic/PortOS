/** Voice profile asset publication over real files, with the profile row write
 * held at its commit seam. A backup cut must never land between the audio a
 * profile names and the row that names it (#9982). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root;
let profile;
let beforeRowWrite = async () => {};
let rowWrites;
const synthesize = vi.fn();
vi.mock('./tts.js', () => ({ synthesize: (...args) => synthesize(...args) }));
vi.mock('../../lib/paths.js', async () => {
  const actual = await vi.importActual('../../lib/paths.js');
  return { ...actual, PATHS: { ...actual.PATHS, get voiceProfiles() { return root; } } };
});
// A single in-memory profile row. Every row write awaits `beforeRowWrite`.
vi.mock('../../lib/db.js', () => ({
  query: async (sql, args = []) => {
    if (sql.includes('SELECT data FROM voice_profiles WHERE id')) return { rows: profile ? [{ data: profile }] : [] };
    if (sql.includes('UPDATE voice_profiles SET')) {
      await beforeRowWrite();
      rowWrites.push('update');
      profile = { ...profile, benchmark: { ...profile.benchmark, ...JSON.parse(args[1]).benchmark } };
      return { rows: [{ data: profile }] };
    }
    if (sql.includes('INSERT INTO voice_profiles')) {
      await beforeRowWrite();
      rowWrites.push('insert');
      profile = JSON.parse(args[4]);
      return { rows: [] };
    }
    return { rows: [] };
  },
}));

const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
const { createClonedVoiceCandidate } = await import('./profiles.js');
const { VOICE_PROFILE_BENCHMARK_LINES, renderProfileBenchmark } = await import('./profileBenchmarks.js');

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const LINE_COUNT = VOICE_PROFILE_BENCHMARK_LINES.length;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const settleSeveral = async () => { for (let i = 0; i < 5; i += 1) await settle(); };
const holdRowWrite = () => {
  const reached = deferred();
  const commit = deferred();
  beforeRowWrite = async () => { reached.resolve(); await commit.promise; };
  return { reached: reached.promise, commit: commit.resolve };
};
const filesUnder = path => readdir(path).catch(() => []);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'voice-admission-test-'));
  beforeRowWrite = async () => {};
  rowWrites = [];
  profile = {
    id: PROFILE_ID, version: 1, label: 'Example Character', kind: 'preset', engine: 'kokoro', voiceId: 'kokoro:example',
    binding: { universeId: 'universe-1', characterId: 'character-1' },
    routes: { studio: { enabled: true }, interactive: { enabled: false } },
    mastering: { chain: ['preset-output:unprocessed'] },
    approval: { status: 'approved', approvedAt: '2026-01-01T00:00:00.000Z', benchmarkRevision: 1 },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  synthesize.mockReset().mockResolvedValue({ wav: Buffer.from('synthetic wav'), latencyMs: 5, engine: 'kokoro', provenance: {} });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('voice benchmark publication', () => {
  const benchmarkDir = () => join(root, PROFILE_ID, 'benchmarks', 'v1');
  // What a snapshot holds: the audio copied and the benchmark lines the row names.
  const capture = async () => ({ files: (await filesUnder(benchmarkDir())).length, named: profile.benchmark?.lines?.length ?? 0 });

  it('drains audio already written through the benchmark row that names it', async () => {
    const hold = holdRowWrite();
    const render = renderProfileBenchmark(PROFILE_ID);
    await hold.reached;
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
    await settleSeveral();
    expect(cutReady).toBe(false);
    hold.commit();
    await render;
    const release = await cut;
    expect(await capture()).toEqual({ files: LINE_COUNT, named: LINE_COUNT });
    release();
  });

  it('keeps synthesis running during a cut but publishes no audio or row until it ends', async () => {
    const release = await acquireBackupSnapshotCut();
    const render = renderProfileBenchmark(PROFILE_ID);
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(LINE_COUNT));
    await settleSeveral();
    expect(await capture()).toEqual({ files: 0, named: 0 });
    expect(rowWrites).toEqual([]);
    release();
    await render;
    expect(await capture()).toEqual({ files: LINE_COUNT, named: LINE_COUNT });
  });
});

describe('cloned voice candidate publication', () => {
  const clone = () => createClonedVoiceCandidate({
    universeId: 'universe-1', characterId: 'character-1', audioBuffer: Buffer.from('synthetic recording'),
    filename: 'sample.wav', performerConsentConfirmed: true,
  });
  // The candidate's directory is minted per call, so look it up from the row.
  const capture = async () => ({
    files: profile?.id && profile.id !== PROFILE_ID ? await filesUnder(join(root, profile.id, 'source')) : [],
    named: profile?.id && profile.id !== PROFILE_ID ? profile.sourceAssets.map(asset => asset.filename) : [],
  });

  it('drains a recording already written through the candidate row that names it', async () => {
    const hold = holdRowWrite();
    const creation = clone();
    await hold.reached;
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
    await settleSeveral();
    expect(cutReady).toBe(false);
    hold.commit();
    await creation;
    const release = await cut;
    expect(await capture()).toEqual({ files: ['sample.wav'], named: ['sample.wav'] });
    release();
  });

  it('writes neither the recording nor the row while a cut is open', async () => {
    const release = await acquireBackupSnapshotCut();
    const creation = clone();
    await settleSeveral();
    expect(await filesUnder(root)).toEqual([]);
    expect(rowWrites).toEqual([]);
    release();
    await creation;
    expect(await capture()).toEqual({ files: ['sample.wav'], named: ['sample.wav'] });
  });
});
