/**
 * The training run's boundaries.
 *
 * Every assertion here pins something invisible to the trained head's scores:
 * a forge token reaching the trainer's environment, a second 4B encoder load
 * from two overlapping runs, and a run that promotes its own output.
 */

import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dataRoot = await mkdtemp(join(tmpdir(), 'portos-jev-training-'));
vi.mock('../lib/paths.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: dataRoot } };
});

const execFile = vi.fn();
vi.mock('../lib/childProcess.js', () => ({
  execFile: (command, args, options, callback) => execFile(command, args, options, callback),
  spawn: vi.fn(),
}));

const getJevStatus = vi.fn();
const jevPythonPath = vi.fn();
vi.mock('./jev.js', () => ({
  getJevStatus,
  jevPythonPath,
  // The real one, re-declared rather than imported: importing the module under
  // mock would defeat the mock. Its contract is what the assertion below reads.
  buildJevEnv: (source = process.env) => ({
    PATH: source.PATH,
    HOME: source.HOME,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
  }),
}));

const findCachedRepoFiles = vi.fn();
vi.mock('../lib/hfCache.js', () => ({ findCachedRepoFiles, getHfCacheRoot: () => '/tmp/hf-cache-double' }));

const buildScopeAdherenceCorpus = vi.fn();
vi.mock('./jevCorpusBuilder.js', () => ({ buildScopeAdherenceCorpus }));

const saveCandidateJevHead = vi.fn();
const adoptJevHead = vi.fn();
vi.mock('./jevHeads.js', () => ({
  saveCandidateJevHead,
  adoptJevHead,
  jevEmbeddingsDir: () => join(dataRoot, 'jev', 'embeddings'),
  jevHeadsDir: () => join(dataRoot, 'jev', 'heads'),
}));

const resolveForgeForRepo = vi.fn();
vi.mock('./forgeAuth.js', () => ({ resolveForgeForRepo }));

const tryReadFile = vi.fn();
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({ ...(await importOriginal()), tryReadFile }));

const { trainScopeAdherenceHead, isJevTrainingRunning } = await import('./jevTraining.js');

const METRICS = { trained: 0.71, stockZeroShot: 0.58, majorityClass: 0.52, goldSize: 40, trainSize: 120 };
const HEAD = { decisionId: 'scope-adherence', architecture: 'linear', metrics: METRICS };

/** A run where every dependency is healthy and the trainer reports success. */
function happyPath() {
  getJevStatus.mockResolvedValue({ ready: true });
  findCachedRepoFiles.mockResolvedValue(['/hf/snapshots/abc/qwen3.5-4b-nli/config.json']);
  jevPythonPath.mockReturnValue('/venv/bin/python3');
  resolveForgeForRepo.mockResolvedValue({ cli: 'gh', env: { ...process.env, GH_TOKEN: 'synthetic-token' } });
  buildScopeAdherenceCorpus.mockResolvedValue({
    ok: true,
    corpusHash: 'deadbeefcafe0001',
    corpusDir: join(dataRoot, 'jev', 'corpora', 'scope-adherence-deadbeefcafe0001'),
    trainSize: 120,
    goldSize: 40,
    sources: { 'merged-pr': 90, 'closed-unmerged-pr': 0, 'closed-not-planned-issue': 70, 'parked-issue': 0 },
    shadow: { observed: 12, compared: 4, agreementRate: 0.75 },
  });
  execFile.mockImplementation((_command, _args, _options, callback) => callback(null, {
    stdout: `encoded 1/2\n${JSON.stringify({ ok: true, metrics: METRICS, finalLoss: 0.3, device: 'cpu' })}\n`,
    stderr: '',
  }));
  tryReadFile.mockResolvedValue(JSON.stringify(HEAD));
  saveCandidateJevHead.mockResolvedValue({ ok: true, head: HEAD });
}

beforeEach(() => {
  vi.clearAllMocks();
  happyPath();
});

describe('trainScopeAdherenceHead', () => {
  it('writes a candidate and never promotes it', async () => {
    const result = await trainScopeAdherenceHead();
    expect(result).toMatchObject({ ok: true, decisionId: 'scope-adherence', metrics: METRICS });
    expect(saveCandidateJevHead).toHaveBeenCalledWith('scope-adherence', HEAD);
    expect(adoptJevHead).not.toHaveBeenCalled();
    // The three baselines and the corpus balance come back; no example does.
    expect(result.corpus.sources['merged-pr']).toBe(90);
    expect(JSON.stringify(result)).not.toContain('synthetic-token');
  });

  // The privacy boundary the whole design rests on: the corpus build reads the
  // forge with a token, and the TRAINER must not receive it — nor any other
  // credential, nor a network-capable Hugging Face mode.
  it('gives the trainer the hardened offline environment, never the forge token', async () => {
    await trainScopeAdherenceHead();
    const [command, args, options] = execFile.mock.calls[0];
    expect(command).toBe('/venv/bin/python3');
    expect(args[0]).toMatch(/train_jev_head\.py$/);
    expect(options.env.GH_TOKEN).toBeUndefined();
    expect(options.env.GITHUB_TOKEN).toBeUndefined();
    expect(options.env.HF_HUB_OFFLINE).toBe('1');
    // Which encoder it is fit on is passed explicitly, so the head can record
    // the revision its loader will later refuse a mismatch against.
    expect(args).toContain('--revision');
    expect(args).toContain('--corpus-hash');
  });

  // Two overlapping runs would load a second 4B encoder on a machine that may
  // already be holding the sidecar's copy resident.
  it('joins a run already in flight rather than starting a second', async () => {
    let release;
    // Resolved when the trainer has actually been spawned. Calling `release`
    // before that point would throw inside the test and leave the in-flight
    // promise pending forever, wedging every case after this one.
    const spawned = new Promise((reached) => {
      execFile.mockImplementation((_command, _args, _options, callback) => {
        release = () => callback(null, { stdout: JSON.stringify({ ok: true, metrics: METRICS }), stderr: '' });
        reached();
      });
    });
    const first = trainScopeAdherenceHead();
    const second = trainScopeAdherenceHead();
    await spawned;
    expect(isJevTrainingRunning()).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(isJevTrainingRunning()).toBe(false);
  });

  it('reports the trainer\'s own code rather than collapsing every failure into one', async () => {
    execFile.mockImplementation((_command, _args, _options, callback) => {
      const error = new Error('exit 1');
      error.stdout = `${JSON.stringify({ ok: false, code: 'jev-corpus-split-overlap' })}\n`;
      callback(error);
    });
    expect(await trainScopeAdherenceHead()).toEqual({ ok: false, code: 'jev-corpus-split-overlap' });
    expect(saveCandidateJevHead).not.toHaveBeenCalled();
  });

  it('refuses to train before the scorer install is finished', async () => {
    getJevStatus.mockResolvedValue({ ready: false });
    expect(await trainScopeAdherenceHead()).toEqual({ ok: false, code: 'jev-head-runtime-unavailable' });
    expect(buildScopeAdherenceCorpus).not.toHaveBeenCalled();
  });

  it('forwards a corpus refusal untouched instead of training on it', async () => {
    buildScopeAdherenceCorpus.mockResolvedValue({ ok: false, code: 'jev-corpus-split-overlap' });
    expect(await trainScopeAdherenceHead()).toEqual({ ok: false, code: 'jev-corpus-split-overlap' });
    expect(execFile).not.toHaveBeenCalled();
  });
});
