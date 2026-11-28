import { jevEvents } from './jevEvents.js';
/**
 * The training run's boundaries.
 *
 * Every assertion here pins something invisible to the trained head's scores:
 * a forge token reaching the trainer's environment, a second 4B encoder load
 * from two overlapping runs, and a run that promotes its own output.
 */

import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// The shared helper re-roots every `PATHS` member under `data/`, not just
// `PATHS.data` — a bare spread leaves the rest pointing at the live install.
const PREFIX = 'portos-jev-training-';
vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot(PREFIX),
}));

afterAll(() => cleanupTempDataRoots());

const bufferedSpawn = vi.fn();
vi.mock('../lib/bufferedSpawn.js', async (original) => ({ ...await original(), bufferedSpawn }));

const getJevStatus = vi.fn();
const jevVenvSpawnTarget = vi.fn();
vi.mock('./jev.js', () => ({ getJevStatus, jevVenvSpawnTarget }));

const findCachedRepoFiles = vi.fn();
vi.mock('../lib/hfCache.js', () => ({ findCachedRepoFiles, getHfCacheRoot: () => '/tmp/hf-cache-double' }));

const buildScopeAdherenceCorpus = vi.fn();
vi.mock('./jevCorpusBuilder.js', () => ({ buildScopeAdherenceCorpus }));

const saveCandidateJevHead = vi.fn();
// No `adoptJevHead` double: this module does not import it, so a spy on one
// could never fire and would assert nothing. "Training never promotes" is
// enforced where promotion actually lives — `jevHeads.test.js`.
vi.mock('./jevHeads.js', () => ({ saveCandidateJevHead }));

const resolveForgeForRepo = vi.fn();
vi.mock('./forgeAuth.js', () => ({ resolveForgeForRepo }));

const tryReadFile = vi.fn();
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({ ...(await importOriginal()), tryReadFile }));

const { cancelJevTraining, trainScopeAdherenceHead, isJevTrainingRunning } = await import('./jevTraining.js');

const METRICS = { trained: 0.71, stockZeroShot: 0.58, majorityClass: 0.52, goldSize: 40, trainSize: 120 };
const HEAD = { decisionId: 'scope-adherence', architecture: 'linear', metrics: METRICS };

/** A run where every dependency is healthy and the trainer reports success. */
function happyPath() {
  getJevStatus.mockResolvedValue({ ready: true });
  findCachedRepoFiles.mockResolvedValue(['/hf/snapshots/abc/qwen3.5-4b-nli/config.json']);
  // The one value the service is given: interpreter AND hardened options
  // together, exactly as `services/jev.js` composes them for the sidecar.
  jevVenvSpawnTarget.mockReturnValue({
    pythonPath: '/venv/bin/python3',
    options: {
      cwd: '/venv/bin',
      env: { PATH: '/usr/bin', HOME: '/home/test', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
    },
  });
  resolveForgeForRepo.mockResolvedValue({ cli: 'gh', env: { ...process.env, GH_TOKEN: 'synthetic-token' } });
  buildScopeAdherenceCorpus.mockResolvedValue({
    ok: true,
    corpusHash: 'deadbeefcafe0001',
    majorityClass: 0.52,
    corpusDir: join(lazyTempDataRoot(PREFIX), 'jev', 'corpora', 'scope-adherence-deadbeefcafe0001'),
    trainSize: 120,
    goldSize: 40,
    sources: { 'merged-pr': 90, 'closed-unmerged-pr': 0, 'closed-not-planned-issue': 70, 'parked-issue': 0 },
    shadow: { observed: 12, compared: 4, agreementRate: 0.75 },
  });
  bufferedSpawn.mockResolvedValue({
    stdout: `encoded 1/2\n${JSON.stringify({ ok: true, metrics: METRICS, finalLoss: 0.3, device: 'cpu' })}\n`,
    stderr: '',
  });
  tryReadFile.mockResolvedValue(JSON.stringify(HEAD));
  saveCandidateJevHead.mockResolvedValue({ ok: true, head: HEAD });
}

beforeEach(() => {
  vi.clearAllMocks();
  happyPath();
});

describe('trainScopeAdherenceHead', () => {
  it('writes a candidate and reports its scores without a corpus row', async () => {
    const result = await trainScopeAdherenceHead();
    expect(result).toMatchObject({ ok: true, decisionId: 'scope-adherence', metrics: METRICS });
    expect(saveCandidateJevHead).toHaveBeenCalledWith('scope-adherence', HEAD);
    // The three baselines and the corpus balance come back; no example does.
    expect(result.corpus.sources['merged-pr']).toBe(90);
    expect(JSON.stringify(result)).not.toContain('synthetic-token');
  });

  // The privacy boundary the whole design rests on: the corpus build reads the
  // forge with a token, and the TRAINER must not receive it — nor any other
  // credential, nor a network-capable Hugging Face mode.
  it('gives the trainer the hardened offline environment, never the forge token', async () => {
    await trainScopeAdherenceHead();
    const [command, args, options] = bufferedSpawn.mock.calls[0];
    expect(command).toBe('/venv/bin/python3');
    expect(args[0]).toMatch(/train_jev_head\.py$/);
    // The options come from `jevVenvSpawnTarget` — the SAME value the sidecar
    // is spawned with — rather than being recomposed here, so the environment
    // cannot drift from the one the guarantee describes.
    expect(options.env.GH_TOKEN).toBeUndefined();
    expect(options.env.GITHUB_TOKEN).toBeUndefined();
    expect(options.env.HF_HUB_OFFLINE).toBe('1');
    expect(options).toMatchObject({ timeoutMs: 3_600_000, processGroup: true });
    // Which encoder it is fit on is passed explicitly, so the head can record
    // the revision its loader will later refuse a mismatch against.
    expect(args).toContain('--revision');
    expect(args).toContain('--corpus-hash');
    // Per-decision embedding cache, so a run can prune its own stale keys.
    expect(args[args.indexOf('--cache-dir') + 1]).toMatch(/embeddings[/\\]scope-adherence$/);
  });

  // Both languages compute the majority-class baseline; the gate reads the
  // Python one. A disagreement means they are not looking at the same gold set,
  // which would make the adoption evidence meaningless.
  it('refuses a head whose majority-class baseline disagrees with the corpus', async () => {
    buildScopeAdherenceCorpus.mockResolvedValue({
      ok: true,
      corpusHash: 'deadbeefcafe0001',
      majorityClass: 0.61,
      corpusDir: join(lazyTempDataRoot(PREFIX), 'jev', 'corpora', 'scope-adherence-deadbeefcafe0001'),
      trainSize: 120,
      goldSize: 40,
      sources: { 'merged-pr': 90, 'closed-unmerged-pr': 0, 'closed-not-planned-issue': 70, 'parked-issue': 0 },
      shadow: { observed: 12, compared: 4, agreementRate: 0.75 },
    });
    expect(await trainScopeAdherenceHead()).toEqual({ ok: false, code: 'jev-head-training-failed' });
    expect(saveCandidateJevHead).not.toHaveBeenCalled();
  });

  // Two overlapping runs would load a second 4B encoder on a machine that may
  // already be holding the sidecar's copy resident.
  it('joins a run already in flight rather than starting a second', async () => {
    let release;
    // Resolved when the trainer has actually been spawned. Calling `release`
    // before that point would throw inside the test and leave the in-flight
    // promise pending forever, wedging every case after this one.
    const spawned = new Promise((reached) => {
      bufferedSpawn.mockImplementation(() => new Promise((resolve) => {
        release = () => resolve({ stdout: JSON.stringify({ ok: true, metrics: METRICS }) });
        reached();
      }));
    });
    const states = [];
    const changed = () => states.push(isJevTrainingRunning());
    jevEvents.on('heads', changed);
    const first = trainScopeAdherenceHead();
    const second = trainScopeAdherenceHead();
    await spawned;
    expect(isJevTrainingRunning()).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(bufferedSpawn).toHaveBeenCalledTimes(1);
    expect(isJevTrainingRunning()).toBe(false);
    jevEvents.off('heads', changed);
    expect(states).toEqual([true, false]);
  });

  it('reports the trainer\'s own code rather than collapsing every failure into one', async () => {
    bufferedSpawn.mockResolvedValue({ success: false, stdout: JSON.stringify({ ok: false, code: 'jev-corpus-split-overlap' }) });
    expect(await trainScopeAdherenceHead()).toEqual({ ok: false, code: 'jev-corpus-split-overlap' });
    expect(saveCandidateJevHead).not.toHaveBeenCalled();
  });

  it('aborts the trainer, keeps its slot until teardown, and preserves the candidate', async () => {
    const { promise: spawned, resolve: markSpawned } = Promise.withResolvers();
    const { promise: stopped, resolve: confirmStopped } = Promise.withResolvers();
    bufferedSpawn.mockImplementationOnce((_command, _args, { signal }) => {
      markSpawned(signal);
      return stopped;
    });

    expect(cancelJevTraining()).toEqual({ cancelled: false });
    const run = trainScopeAdherenceHead();
    const signal = await spawned;
    expect(cancelJevTraining()).toEqual({ cancelled: true });
    expect(signal.aborted).toBe(true);
    expect(isJevTrainingRunning()).toBe(true);
    expect(trainScopeAdherenceHead()).toBe(run);
    confirmStopped({ stdout: JSON.stringify({ ok: true, metrics: METRICS }) });

    await expect(run).resolves.toEqual({ ok: false, cancelled: true, code: 'jev-head-training-cancelled' });
    expect(saveCandidateJevHead).not.toHaveBeenCalled();
    expect(isJevTrainingRunning()).toBe(false);
    await expect(trainScopeAdherenceHead()).resolves.toMatchObject({ ok: true });
  });

  it('forwards cancellation to corpus preparation and skips the trainer', async () => {
    const { promise: preparing, resolve: markPreparing } = Promise.withResolvers();
    buildScopeAdherenceCorpus.mockImplementationOnce(({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ ok: false }), { once: true });
      markPreparing();
    }));

    const run = trainScopeAdherenceHead();
    await preparing;
    expect(cancelJevTraining()).toEqual({ cancelled: true });
    await expect(run).resolves.toMatchObject({ cancelled: true });
    expect(bufferedSpawn).not.toHaveBeenCalled();
  });

  it('refuses to train before the scorer install is finished', async () => {
    getJevStatus.mockResolvedValue({ ready: false });
    expect(await trainScopeAdherenceHead()).toEqual({ ok: false, code: 'jev-head-runtime-unavailable' });
    expect(buildScopeAdherenceCorpus).not.toHaveBeenCalled();
  });

  it('forwards a corpus refusal untouched instead of training on it', async () => {
    buildScopeAdherenceCorpus.mockResolvedValue({ ok: false, code: 'jev-corpus-split-overlap' });
    expect(await trainScopeAdherenceHead()).toEqual({ ok: false, code: 'jev-corpus-split-overlap' });
    expect(bufferedSpawn).not.toHaveBeenCalled();
  });
});
