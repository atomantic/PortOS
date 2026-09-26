/**
 * jev sidecar lifecycle.
 *
 * The regressions these pin are all invisible to a behavioral assertion on the
 * scores: a second 9 GB process, a sidecar spawned at import time, weights that
 * stay resident forever, and a Python traceback reaching an operator payload.
 * Each one leaves `scoreHypotheses` returning correct numbers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.fn();
const findCachedRepoFiles = vi.fn();
const existsSync = vi.fn();

// The runtime probe runs through promisify(execFile); a bare vi.fn() would
// never invoke the callback and every status read would hang.
const execFile = vi.fn((_command, _args, options, callback) => {
  (typeof options === 'function' ? options : callback)(new Error('probe unavailable'));
  return {};
});
vi.mock('../lib/childProcess.js', () => ({ spawn, execFile }));
vi.mock('../lib/hfCache.js', () => ({ findCachedRepoFiles, getHfCacheRoot: () => '/tmp/hf-cache-double' }));
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal()), existsSync }));
vi.mock('./hfDownload.js', () => ({ downloadHfRepo: vi.fn() }));
vi.mock('../lib/pythonSetup.js', () => ({
  createVenv: vi.fn(),
  detectVenvBasePythonSync: vi.fn(() => null),
  installPackages: vi.fn(),
}));

const MODEL_FILE = '/hf/snapshots/abc/qwen3.5-4b-nli/config.json';

/** A spawned child that never exits on its own, like a healthy sidecar. */
function fakeChild() {
  const listeners = new Map();
  return {
    exitCode: null,
    killed: false,
    stdout: { resume: vi.fn() },
    stderr: { resume: vi.fn() },
    on(event, handler) { listeners.set(event, handler); return this; },
    kill(signal) { this.killed = true; this.exitCode = 0; listeners.get('close')?.(0, signal); },
    emitClose(code) { this.exitCode = code; listeners.get('close')?.(code); },
  };
}

/** An installed, cached, ready host. */
function makeInstalled() {
  existsSync.mockReturnValue(true);
  findCachedRepoFiles.mockResolvedValue([MODEL_FILE]);
}

const healthOk = { ok: true, json: async () => ({ ready: true, device: 'cpu' }) };
const scoreOk = (scores) => ({
  ok: true,
  text: async () => JSON.stringify({ schemaVersion: 1, complete: true, scores }),
});

let jev;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  jev = await import('./jev.js');
});

afterEach(() => {
  jev.stopJevSidecar();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('no cold bootstrap', () => {
  // AI Provider Usage Policy: importing the module must load nothing. A
  // top-level `ensureSidecar()` would pass every scoring assertion below.
  it('spawns nothing on import', () => {
    expect(spawn).not.toHaveBeenCalled();
    expect(jev.isJevSidecarRunning()).toBe(false);
  });

  it('spawns nothing for a status read', async () => {
    makeInstalled();
    await jev.getJevStatus();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('scoreHypotheses', () => {
  it('reports jev-not-installed when the pinned snapshot is absent, and starts nothing', async () => {
    existsSync.mockReturnValue(true);
    findCachedRepoFiles.mockResolvedValue(null);
    expect(await jev.scoreHypotheses({ premise: 'p', hypotheses: ['a', 'b'] }))
      .toEqual({ ok: false, code: 'jev-not-installed' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports jev-not-installed when no dedicated virtualenv exists', async () => {
    existsSync.mockReturnValue(false);
    findCachedRepoFiles.mockResolvedValue([MODEL_FILE]);
    expect(await jev.scoreHypotheses({ premise: 'p', hypotheses: ['a', 'b'] }))
      .toEqual({ ok: false, code: 'jev-not-installed' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('separates a too-large premise from an otherwise malformed request', async () => {
    makeInstalled();
    expect(await jev.scoreHypotheses({ premise: 'x'.repeat(40_000), hypotheses: ['a', 'b'] }))
      .toEqual({ ok: false, code: 'jev-premise-too-large' });
    expect(await jev.scoreHypotheses({ premise: '', hypotheses: ['a'] }))
      .toEqual({ ok: false, code: 'jev-request-invalid' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('binds the sidecar to loopback on the declared port and returns ordered scores', async () => {
    makeInstalled();
    spawn.mockReturnValue(fakeChild());
    const scores = [
      { hypothesis: 'a', entailment: 0.9, contradiction: 0.05, neutral: 0.05 },
      { hypothesis: 'b', entailment: 0.1, contradiction: 0.8, neutral: 0.1 },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).endsWith('/health') ? healthOk : scoreOk(scores))));

    const result = await jev.scoreHypotheses({ premise: 'p', hypotheses: ['a', 'b'] });
    expect(result).toEqual({ ok: true, scores });

    const { PORTS } = await import('../lib/ports.js');
    const args = spawn.mock.calls[0][1];
    expect(args).toContain('--host');
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(args[args.indexOf('--port') + 1]).toBe(String(PORTS.JEV));
    // The model directory is derived from the resolved cache path, never from
    // a request field.
    expect(args[args.indexOf('--model-dir') + 1]).toBe('/hf/snapshots/abc/qwen3.5-4b-nli');
  });

  it('starts exactly one sidecar for two concurrent first callers', async () => {
    makeInstalled();
    spawn.mockReturnValue(fakeChild());
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).endsWith('/health') ? healthOk : scoreOk([
      { hypothesis: 'a', entailment: 0.9, contradiction: 0, neutral: 0.1 },
      { hypothesis: 'b', entailment: 0.1, contradiction: 0, neutral: 0.9 },
    ]))));

    const [first, second] = await Promise.all([
      jev.scoreHypotheses({ premise: 'p', hypotheses: ['a', 'b'] }),
      jev.scoreHypotheses({ premise: 'q', hypotheses: ['a', 'b'] }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reports jev-start-failed when the sidecar dies before reporting ready', async () => {
    makeInstalled();
    const child = fakeChild();
    spawn.mockImplementation(() => { queueMicrotask(() => child.emitClose(1)); return child; });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const pending = jev.scoreHypotheses({ premise: 'p', hypotheses: ['a', 'b'] });
    // Past one health-poll interval, so the readiness loop re-checks and sees
    // the exit rather than waiting out the full start timeout.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toEqual({ ok: false, code: 'jev-start-failed' });
  });

  it('collapses a sidecar error body to a known code rather than forwarding its text', async () => {
    makeInstalled();
    spawn.mockReturnValue(fakeChild());
    // A traceback can carry local paths or the premise. Nothing from it may
    // reach the caller, so an unrecognized body becomes one fixed code.
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).endsWith('/health') ? healthOk : {
      ok: false,
      text: async () => 'Traceback (most recent call last): File "/Users/someone/…", premise=secret',
    })));
    const result = await jev.scoreHypotheses({ premise: 'p', hypotheses: ['a', 'b'] });
    expect(result).toEqual({ ok: false, code: 'jev-response-invalid' });
  });

  it('rejects a reply describing different hypotheses than the ones asked about', async () => {
    makeInstalled();
    spawn.mockReturnValue(fakeChild());
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).endsWith('/health') ? healthOk : scoreOk([
      { hypothesis: 'c', entailment: 0.9, contradiction: 0, neutral: 0.1 },
      { hypothesis: 'd', entailment: 0.1, contradiction: 0, neutral: 0.9 },
    ]))));
    expect(await jev.scoreHypotheses({ premise: 'p', hypotheses: ['a', 'b'] }))
      .toEqual({ ok: false, code: 'jev-response-invalid' });
  });
});

describe('idle unload', () => {
  it('reaps the sidecar after the idle window, and only after it', async () => {
    makeInstalled();
    const { jevEvents } = await import('./jevEvents.js');
    const states = [];
    jevEvents.on('status', () => states.push(jev.isJevSidecarRunning()));
    const child = fakeChild();
    spawn.mockReturnValue(child);
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).endsWith('/health') ? healthOk : scoreOk([
      { hypothesis: 'a', entailment: 0.9, contradiction: 0, neutral: 0.1 },
      { hypothesis: 'b', entailment: 0.1, contradiction: 0, neutral: 0.9 },
    ]))));
    await jev.scoreHypotheses({ premise: 'p', hypotheses: ['a', 'b'] });
    expect(jev.isJevSidecarRunning()).toBe(true);

    const { JEV_IDLE_UNLOAD_MS } = await import('../lib/jev.js');
    vi.advanceTimersByTime(JEV_IDLE_UNLOAD_MS - 1);
    expect(jev.isJevSidecarRunning()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(child.killed).toBe(true);
    expect(jev.isJevSidecarRunning()).toBe(false);
    expect(states).toEqual([true, false]);
  });
});

describe('decide', () => {
  const scoringHost = (scores) => {
    makeInstalled();
    spawn.mockReturnValue(fakeChild());
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).endsWith('/health') ? healthOk : scoreOk(scores))));
  };

  it('abstains on a near-tie instead of returning the nominal winner', async () => {
    scoringHost([
      { hypothesis: 'reply', entailment: 0.52, contradiction: 0.2, neutral: 0.28 },
      { hypothesis: 'none', entailment: 0.49, contradiction: 0.2, neutral: 0.31 },
    ]);
    const result = await jev.decide({ premise: 'p', options: ['reply', 'none'] });
    expect(result).toMatchObject({ ok: true, abstained: true, choice: null });
  });

  // Checked before any forward pass: a single option has no runner-up, so
  // there is no margin and no reason to load a 9 GB model to discover that.
  it('refuses a single option without starting the sidecar', async () => {
    makeInstalled();
    expect(await jev.decide({ premise: 'p', options: ['only'] }))
      .toEqual({ ok: false, code: 'jev-request-invalid' });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('buildJevEnv', () => {
  it('forces the offline flags and passes through no credentials', () => {
    const env = jev.buildJevEnv({
      PATH: '/usr/bin',
      HOME: '/home/example',
      HF_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
      OPENAI_API_KEY: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      PYTHONPATH: '/attacker',
    });
    expect(env).toMatchObject({ HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONNOUSERSITE: '1' });
    expect(Object.keys(env)).toEqual(expect.not.arrayContaining([
      'HF_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PYTHONPATH',
    ]));
  });
});

it('notifies a failed install and an unexpected resident process exit', async () => {
  const { jevEvents } = await import('./jevEvents.js');
  const changed = vi.fn();
  jevEvents.on('status', changed);
  existsSync.mockReturnValue(false);
  findCachedRepoFiles.mockResolvedValue(null);
  expect((await jev.installJev()).ok).toBe(false);
  expect(changed).toHaveBeenCalledWith({});

  makeInstalled();
  const child = fakeChild();
  spawn.mockReturnValue(child);
  vi.stubGlobal('fetch', vi.fn(async (url) => String(url).endsWith('/health') ? healthOk : scoreOk([
    { hypothesis: 'a', entailment: 0.9, contradiction: 0, neutral: 0.1 },
    { hypothesis: 'b', entailment: 0.1, contradiction: 0, neutral: 0.9 },
  ])));
  await jev.scoreHypotheses({ premise: 'p', hypotheses: ['a', 'b'] });
  changed.mockClear();
  child.emitClose(1);
  expect(jev.isJevSidecarRunning()).toBe(false);
  expect(changed).toHaveBeenCalledExactlyOnceWith({});
});
