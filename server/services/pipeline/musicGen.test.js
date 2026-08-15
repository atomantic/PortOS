import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir, platform as osPlatform, arch as osArch } from 'os';
import { join } from 'path';
import { rm, readdir } from 'fs/promises';
import { writeFileSync, mkdtempSync } from 'fs';

// ---- Pure-helper tests (no mocks needed) ---------------------------------
import {
  buildMusicGenArgs,
  buildSidecarArgs,
  buildMinimaxInstrumentalLyrics,
  clampDuration,
  getMusicgenModel,
  getEngine,
  getEngineModel,
  isEngineReady,
  ENGINES,
  DEFAULT_ENGINE_ID,
  MUSICGEN_MODELS,
  AUDIOLDM2_MODELS,
  DEFAULT_MUSICGEN_MODEL_ID,
  DEFAULT_AUDIOLDM2_MODEL_ID,
  MIN_DURATION_SEC,
  MAX_DURATION_SEC,
  DEFAULT_DURATION_SEC,
} from './musicGen.js';

describe('MUSICGEN_MODELS registry', () => {
  it('has a stable, unique id + repo for each model', () => {
    const ids = MUSICGEN_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MUSICGEN_MODELS) {
      expect(typeof m.id).toBe('string');
      expect(m.repo).toMatch(/^facebook\/musicgen-/);
      expect(typeof m.name).toBe('string');
    }
  });

  it('default model id resolves to a real entry', () => {
    expect(getMusicgenModel(DEFAULT_MUSICGEN_MODEL_ID)).toBeTruthy();
  });

  it('getMusicgenModel returns null for unknown ids', () => {
    expect(getMusicgenModel('nope')).toBeNull();
    expect(getMusicgenModel(undefined)).toBeNull();
  });
});

describe('AUDIOLDM2_MODELS registry', () => {
  it('has a stable, unique id + cvssp repo for each model', () => {
    const ids = AUDIOLDM2_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of AUDIOLDM2_MODELS) {
      expect(typeof m.id).toBe('string');
      expect(m.repo).toMatch(/^cvssp\/audioldm2/);
      expect(typeof m.name).toBe('string');
    }
  });

  it('default model id resolves within the audioldm2 engine', () => {
    expect(getEngineModel('audioldm2', DEFAULT_AUDIOLDM2_MODEL_ID)).toBeTruthy();
  });
});

describe('ENGINES backend registry', () => {
  it('exposes all backends with the fields the route + UI consume', () => {
    expect(Object.keys(ENGINES).sort()).toEqual(['acestep', 'acestep15', 'audioldm2', 'minimax-music3', 'musicgen']);
    for (const engine of Object.values(ENGINES)) {
      expect(typeof engine.id).toBe('string');
      expect(typeof engine.name).toBe('string');
      expect(Array.isArray(engine.models)).toBe(true);
      expect(engine.models.length).toBeGreaterThan(0);
      expect(engine.models.some((m) => m.id === engine.defaultModelId)).toBe(true);
      expect(engine.minDurationSec).toBeGreaterThanOrEqual(1);
      expect(engine.maxDurationSec).toBeGreaterThanOrEqual(engine.minDurationSec);
      expect(engine.defaultDurationSec).toBeGreaterThanOrEqual(engine.minDurationSec);
      expect(engine.defaultDurationSec).toBeLessThanOrEqual(engine.maxDurationSec);
      expect(typeof engine.resolvePython).toBe('function');
      expect(typeof engine.installEnv).toBe('string');
      expect(engine.scriptPath).toMatch(/generate_\w+\.py$/);
    }
  });

  it('default engine is musicgen (back-compat)', () => {
    expect(DEFAULT_ENGINE_ID).toBe('musicgen');
    expect(getEngine(DEFAULT_ENGINE_ID).id).toBe('musicgen');
  });

  it('audioldm2 has a wider duration window than musicgen (long-form)', () => {
    expect(ENGINES.audioldm2.maxDurationSec).toBeGreaterThan(ENGINES.musicgen.maxDurationSec);
  });

  it('keeps ACE-Step 1.5 separate from v1 and requires its fixed installed snapshot', () => {
    expect(ENGINES.acestep15).toMatchObject({
      id: 'acestep15', installEnv: 'INSTALL_ACESTEP15', lyrics: true,
      customModels: false, fixedModelInstall: true,
    });
    expect(ENGINES.acestep15.models).toEqual([expect.objectContaining({ repo: 'ACE-Step/Ace-Step1.5' })]);
    expect(ENGINES.acestep15.scriptPath).toMatch(/generate_acestep15\.py$/);
    expect(ENGINES.acestep.models[0].repo).toBe('ACE-Step/ACE-Step-v1-3.5B');
  });

  it('musicgen window mirrors the legacy module-level constants', () => {
    expect(ENGINES.musicgen.minDurationSec).toBe(MIN_DURATION_SEC);
    expect(ENGINES.musicgen.maxDurationSec).toBe(MAX_DURATION_SEC);
    expect(ENGINES.musicgen.defaultDurationSec).toBe(DEFAULT_DURATION_SEC);
  });
});

describe('getEngine / getEngineModel', () => {
  it('falls back to the default engine for an unknown id', () => {
    expect(getEngine('does-not-exist').id).toBe(DEFAULT_ENGINE_ID);
    expect(getEngine(undefined).id).toBe(DEFAULT_ENGINE_ID);
  });

  it('resolves a model within the named engine', () => {
    expect(getEngineModel('musicgen', 'musicgen-small').repo).toBe('facebook/musicgen-small');
    expect(getEngineModel('audioldm2', 'audioldm2-large').repo).toBe('cvssp/audioldm2-large');
  });

  it('returns null when the model belongs to a different engine', () => {
    // musicgen-small is not an audioldm2 model — selection must not bleed across engines.
    expect(getEngineModel('audioldm2', 'musicgen-small')).toBeNull();
    expect(getEngineModel('musicgen', 'audioldm2')).toBeNull();
  });
});

describe('clampDuration', () => {
  it('passes through an in-range value (default engine)', () => {
    expect(clampDuration(12)).toBe(12);
  });
  it('floors at MIN and caps at MAX for musicgen', () => {
    expect(clampDuration(0, 'musicgen')).toBe(ENGINES.musicgen.minDurationSec);
    expect(clampDuration(-5, 'musicgen')).toBe(ENGINES.musicgen.minDurationSec);
    expect(clampDuration(9999, 'musicgen')).toBe(ENGINES.musicgen.maxDurationSec);
  });
  it('uses the audioldm2 window when that engine is named', () => {
    // 90s is over musicgen's 30s ceiling but inside audioldm2's window.
    expect(clampDuration(90, 'audioldm2')).toBe(90);
    expect(clampDuration(9999, 'audioldm2')).toBe(ENGINES.audioldm2.maxDurationSec);
  });
  it('falls back to the engine default on non-finite input', () => {
    expect(clampDuration(NaN, 'musicgen')).toBe(ENGINES.musicgen.defaultDurationSec);
    expect(clampDuration('abc', 'audioldm2')).toBe(ENGINES.audioldm2.defaultDurationSec);
    expect(clampDuration(undefined)).toBe(DEFAULT_DURATION_SEC);
  });
});

describe('buildSidecarArgs', () => {
  it('routes ACE-Step 1.5 to its own sidecar with the fixed model repo and lyrics', () => {
    const { args } = buildSidecarArgs({
      engineId: 'acestep15', pythonPath: '/venv/python', repo: 'ACE-Step/Ace-Step1.5',
      prompt: 'bright pop', lyrics: '[Verse] Example', durationSec: 999, outputPath: '/tmp/out.wav',
    });
    expect(args[0]).toMatch(/generate_acestep15\.py$/);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'ACE-Step/Ace-Step1.5']);
    expect(args.slice(args.indexOf('--duration'), args.indexOf('--duration') + 2)).toEqual(['--duration', '240']);
    expect(args.slice(args.indexOf('--lyrics'), args.indexOf('--lyrics') + 2)).toEqual(['--lyrics', '[Verse] Example']);
  });

  it('builds MiniMax Music 3 args with lyrics and clamps to five minutes', () => {
    const { args } = buildSidecarArgs({
      engineId: 'minimax-music3', pythonPath: '/venv/python', repo: 'MiniMaxAI/MiniMax-Music3',
      prompt: 'cinematic synthwave', lyrics: 'Example lyrics', durationSec: 999, outputPath: '/tmp/out.wav',
    });
    expect(args).toContain('MiniMaxAI/MiniMax-Music3');
    expect(args.slice(args.indexOf('--duration'), args.indexOf('--duration') + 2)).toEqual(['--duration', '300']);
    expect(args.slice(args.indexOf('--lyrics'), args.indexOf('--lyrics') + 2)).toEqual(['--lyrics', 'Example lyrics']);
  });
  const base = {
    pythonPath: '/venv/bin/python3',
    repo: 'facebook/musicgen-medium',
    prompt: 'tense cinematic synth',
    durationSec: 10,
    outputPath: '/data/music/music-gen-abc.wav',
  };

  it('strips markdown emphasis out of the prompt for every engine', () => {
    // The prompt box is a plain textarea; users type markdown into it out of
    // habit and the text encoders tokenize `**`/`_` as literal content.
    const textArg = (args) => args[args.indexOf('--text') + 1];
    for (const engineId of Object.keys(ENGINES)) {
      const { args } = buildSidecarArgs({
        ...base, engineId, repo: 'some/repo',
        prompt: 'slow-burning, cinematic instrumental with a **dark** `analog` pulse',
      });
      expect(textArg(args), engineId).toBe('slow-burning, cinematic instrumental with a dark analog pulse');
    }
  });

  it('routes to the musicgen sidecar script for the musicgen engine', () => {
    const { bin, args } = buildSidecarArgs({ ...base, engineId: 'musicgen' });
    expect(bin).toBe('/venv/bin/python3');
    expect(args[0]).toMatch(/generate_musicgen\.py$/);
    const flag = (name) => args[args.indexOf(name) + 1];
    expect(flag('--model')).toBe('facebook/musicgen-medium');
    expect(flag('--text')).toBe('tense cinematic synth');
    expect(flag('--output')).toBe('/data/music/music-gen-abc.wav');
  });

  it('routes to the audioldm2 sidecar script for the audioldm2 engine', () => {
    const { args } = buildSidecarArgs({ ...base, engineId: 'audioldm2', repo: 'cvssp/audioldm2' });
    expect(args[0]).toMatch(/generate_audioldm2\.py$/);
    expect(args[args.indexOf('--model') + 1]).toBe('cvssp/audioldm2');
  });

  it('clamps the duration to the engine window', () => {
    // 120s clamps to musicgen's 30s but passes through for audioldm2.
    const mg = buildSidecarArgs({ ...base, engineId: 'musicgen', durationSec: 120 });
    expect(mg.args[mg.args.indexOf('--duration') + 1]).toBe(String(ENGINES.musicgen.maxDurationSec));
    const ald = buildSidecarArgs({ ...base, engineId: 'audioldm2', durationSec: 120 });
    expect(ald.args[ald.args.indexOf('--duration') + 1]).toBe('120');
  });

  it('passes the runtime-dir flag (default per engine)', () => {
    const { args } = buildSidecarArgs({ ...base, engineId: 'audioldm2' });
    expect(args).toContain('--runtime-dir');
  });

  it('threads --lyrics ONLY for lyric-aware engines (acestep)', () => {
    const ace = buildSidecarArgs({ ...base, engineId: 'acestep', repo: 'ACE-Step/ACE-Step-v1-3.5B', lyrics: '[verse]\nhello' });
    expect(ace.args[0]).toMatch(/generate_acestep\.py$/);
    expect(ace.args).toContain('--lyrics');
    expect(ace.args[ace.args.indexOf('--lyrics') + 1]).toBe('[verse]\nhello');
    // Non-lyric engines never get the flag, even when lyrics are passed.
    const mg = buildSidecarArgs({ ...base, engineId: 'musicgen', lyrics: 'ignored' });
    expect(mg.args).not.toContain('--lyrics');
    const ald = buildSidecarArgs({ ...base, engineId: 'audioldm2', lyrics: 'ignored' });
    expect(ald.args).not.toContain('--lyrics');
  });

  it('sends an empty --lyrics for acestep when none provided (never undefined)', () => {
    const { args } = buildSidecarArgs({ ...base, engineId: 'acestep' });
    expect(args).toContain('--lyrics');
    expect(args[args.indexOf('--lyrics') + 1]).toBe('');
  });
});

describe('acestep engine entry', () => {
  it('is lyric-aware, fixed-checkpoint, and uses the acestep sidecar', () => {
    expect(ENGINES.acestep.lyrics).toBe(true);
    expect(ENGINES.acestep.customModels).toBe(false); // single foundation checkpoint
    expect(ENGINES.acestep.scriptPath).toMatch(/generate_acestep\.py$/);
    expect(ENGINES.acestep.installEnv).toBe('INSTALL_ACESTEP');
  });

  it('the other engines are NOT lyric-aware but DO accept custom HF checkpoints', () => {
    expect(ENGINES.musicgen.lyrics).toBeUndefined();
    expect(ENGINES.audioldm2.lyrics).toBeUndefined();
    expect(ENGINES.musicgen.customModels).toBe(true);
    expect(ENGINES.audioldm2.customModels).toBe(true);
  });
});

describe('buildMusicGenArgs (back-compat wrapper)', () => {
  const base = {
    pythonPath: '/venv/bin/python3',
    repo: 'facebook/musicgen-medium',
    prompt: 'tense cinematic synth',
    durationSec: 10,
    outputPath: '/data/music/music-gen-abc.wav',
    runtimeDir: '/home/u/.portos/mlx-examples/musicgen',
  };

  it('builds the musicgen sidecar argv with every flag the script expects', () => {
    const { bin, args } = buildMusicGenArgs(base);
    expect(bin).toBe('/venv/bin/python3');
    expect(args[0]).toMatch(/generate_musicgen\.py$/);
    const flag = (name) => args[args.indexOf(name) + 1];
    expect(flag('--model')).toBe('facebook/musicgen-medium');
    expect(flag('--text')).toBe('tense cinematic synth');
    expect(flag('--output')).toBe('/data/music/music-gen-abc.wav');
    expect(flag('--runtime-dir')).toBe('/home/u/.portos/mlx-examples/musicgen');
  });

  it('passes the clamped duration as a string', () => {
    const { args } = buildMusicGenArgs({ ...base, durationSec: 9999 });
    const dur = args[args.indexOf('--duration') + 1];
    expect(dur).toBe(String(MAX_DURATION_SEC));
    expect(typeof dur).toBe('string');
  });

  it('clamps a sub-minimum duration', () => {
    const { args } = buildMusicGenArgs({ ...base, durationSec: 0 });
    expect(args[args.indexOf('--duration') + 1]).toBe(String(MIN_DURATION_SEC));
  });
});

// ---- generateMusic backend-selection tests (mocked subprocess) -----------
// These exercise the JS plumbing only — they never run Python. The spawn mock
// records which sidecar script was launched and synthesizes a success/failure
// without any model weights.

// Shared mutable state for the mock factories — defined via vi.hoisted so it's
// initialized before the (hoisted) vi.mock factories run.
const h = vi.hoisted(() => ({
  testDir: '',
  spawnCalls: [],
  mockExitCode: 0,
  mockStdout: '',
  mockWriteOutput: true,
  musicgenPython: '/fake/venv-musicgen/bin/python3',
  audioldm2Python: '/fake/venv-audioldm2/bin/python3',
  // isEngineHealthy's import probe: which interpreters it ran, and whether the
  // import succeeded (a half-built venv exits non-zero).
  probeCalls: [],
  probeOk: true,
  // Host identity, so platform-gated engines (MLX MusicGen) behave the same in
  // CI on Linux, on a Windows dev box, and on the Apple Silicon they target.
  osPlatform: 'darwin',
  osArch: 'arm64',
}));
// Set after the top-level imports resolve; the fileUtils mock reads it through
// a getter so the (eagerly-built) PATHS object always reflects the final value.
h.testDir = mkdtempSync(join(tmpdir(), 'musicgen-test-'));
const TEST_DIR = h.testDir;
const spawnCalls = h.spawnCalls;

// Partial: tmpdir() stays real (the suite writes fake WAVs under it); only the
// host identity is driven by the test.
vi.mock('os', async () => ({
  ...(await vi.importActual('os')),
  platform: () => h.osPlatform,
  arch: () => h.osArch,
}));

vi.mock('../../lib/childProcess.js', async () => {
  const actual = await vi.importActual('../../lib/childProcess.js');
  return {
    ...actual,
    // isEngineHealthy probes the venv with `python -c <import>`; promisify()
    // wraps this callback form. h.probeOk drives success vs a broken venv.
    execFile: (file, args, opts, cb) => {
      h.probeCalls.push({ file, args });
      const done = typeof opts === 'function' ? opts : cb;
      setImmediate(() => (h.probeOk
        ? done(null, '', '')
        : done(Object.assign(new Error("ModuleNotFoundError: No module named 'torch'"), { code: 1 }))));
    },
    spawn: (bin, args, _opts) => {
      h.spawnCalls.push({ bin, args });
      const listeners = {};
      const proc = {
        stdout: { on: (event, cb) => { if (event === 'data' && h.mockStdout) cb(Buffer.from(h.mockStdout)); } },
        stderr: { on: (event, cb) => { if (event === 'data') cb(Buffer.from('STAGE:generate\n')); } },
        on: (event, cb) => { listeners[event] = cb; },
        kill: () => {},
      };
      Promise.resolve().then(() => {
        if (h.mockExitCode === 0 && h.mockWriteOutput) {
          const outPath = args[args.indexOf('--output') + 1];
          writeFileSync(outPath, Buffer.from('fake-wav-bytes'));
        }
        listeners.close?.(h.mockExitCode, null);
      });
      return proc;
    },
  };
});

// PATHS.music points at the temp dir so the fake WAV lands somewhere writable.
// `music` is a getter so the value reflects h.testDir even though this factory
// runs (hoisted) before the top-level `h.testDir = mkdtempSync(...)` assignment.
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, get music() { return h.testDir; } },
    ensureDir: async () => {},
  };
});

vi.mock('../../lib/hfToken.js', () => ({ hfChildEnv: async () => ({}) }));

// Venv resolvers — flip readiness per engine per test.
vi.mock('../../lib/pythonSetup.js', async () => {
  const actual = await vi.importActual('../../lib/pythonSetup.js');
  return {
    ...actual,
    resolveMusicgenPython: () => h.musicgenPython,
    resolveAudioldm2Python: () => h.audioldm2Python,
  };
});

const {
  generateMusic, isEngineHealthy, invalidateEngineHealth, isEnginePlatformSupported, enginePlatformLabel,
} = await import('./musicGen.js');

beforeEach(() => {
  h.spawnCalls.length = 0;
  h.mockExitCode = 0;
  h.mockWriteOutput = true;
  h.mockStdout = 'STAGE:done\nRESULT:{"output":"x","durationSec":12.5,"sampleRate":32000}\n';
  h.musicgenPython = '/fake/venv-musicgen/bin/python3';
  h.audioldm2Python = '/fake/venv-audioldm2/bin/python3';
  h.probeCalls.length = 0;
  h.probeOk = true;
  h.osPlatform = 'darwin';
  h.osArch = 'arm64';
  invalidateEngineHealth();
});

afterEach(async () => {
  for (const f of await readdir(TEST_DIR).catch(() => [])) {
    await rm(join(TEST_DIR, f), { force: true }).catch(() => {});
  }
});

describe('generateMusic backend selection', () => {
  it('defaults to the musicgen sidecar', async () => {
    const res = await generateMusic({ prompt: 'calm piano' });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].bin).toBe('/fake/venv-musicgen/bin/python3');
    expect(spawnCalls[0].args[0]).toMatch(/generate_musicgen\.py$/);
    expect(res.engine).toBe('musicgen');
    expect(res.modelId).toBe(DEFAULT_MUSICGEN_MODEL_ID);
    expect(res.filename).toMatch(/^music-gen-.*\.wav$/);
  });

  it('routes to the audioldm2 sidecar + venv when engine=audioldm2', async () => {
    const res = await generateMusic({ prompt: 'ambient drone', engine: 'audioldm2', durationSec: 60 });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].bin).toBe('/fake/venv-audioldm2/bin/python3');
    expect(spawnCalls[0].args[0]).toMatch(/generate_audioldm2\.py$/);
    // 60s is within audioldm2's window — it passes through, not clamped to 30.
    expect(spawnCalls[0].args[spawnCalls[0].args.indexOf('--duration') + 1]).toBe('60');
    expect(res.engine).toBe('audioldm2');
    expect(res.modelId).toBe(DEFAULT_AUDIOLDM2_MODEL_ID);
  });

  it('resolves modelId within the selected engine', async () => {
    await generateMusic({ prompt: 'jazz', engine: 'audioldm2', modelId: 'audioldm2-music' });
    expect(spawnCalls[0].args[spawnCalls[0].args.indexOf('--model') + 1]).toBe('cvssp/audioldm2-music');
  });

  it('falls back to the engine default for a cross-engine modelId', async () => {
    // Passing a musicgen model id to the audioldm2 engine must not leak through.
    await generateMusic({ prompt: 'jazz', engine: 'audioldm2', modelId: 'musicgen-small' });
    expect(spawnCalls[0].args[spawnCalls[0].args.indexOf('--model') + 1]).toBe('cvssp/audioldm2');
  });

  it('throws 503 with the engine-specific install hint when that venv is missing', async () => {
    h.audioldm2Python = null;
    await expect(generateMusic({ prompt: 'x', engine: 'audioldm2' }))
      .rejects.toMatchObject({ status: 503, code: 'PIPELINE_MUSIC_RUNTIME_MISSING' });
    await expect(generateMusic({ prompt: 'x', engine: 'audioldm2' }))
      .rejects.toThrow(/INSTALL_AUDIOLDM2/);
    // musicgen still works — readiness is per engine.
    const res = await generateMusic({ prompt: 'x' });
    expect(res.engine).toBe('musicgen');
  });

  it('rejects an empty prompt with 400 before spawning anything', async () => {
    await expect(generateMusic({ prompt: '   ', engine: 'audioldm2' }))
      .rejects.toMatchObject({ status: 400, code: 'PIPELINE_MUSIC_EMPTY_PROMPT' });
    expect(spawnCalls).toHaveLength(0);
  });

  it('fails 500 and unlinks the partial when the sidecar writes no audio', async () => {
    h.mockWriteOutput = false;
    await expect(generateMusic({ prompt: 'x', engine: 'audioldm2' }))
      .rejects.toMatchObject({ status: 500, code: 'PIPELINE_MUSIC_GEN_FAILED' });
    expect(await readdir(TEST_DIR)).toHaveLength(0);
  });

  it('fails 500 when the sidecar exits non-zero', async () => {
    h.mockExitCode = 1;
    await expect(generateMusic({ prompt: 'x' }))
      .rejects.toMatchObject({ status: 500, code: 'PIPELINE_MUSIC_GEN_FAILED' });
  });

  it('never spawns when the signal is already aborted (cancel raced the call)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(generateMusic({ prompt: 'x', signal: controller.signal }))
      .rejects.toMatchObject({ status: 500, code: 'PIPELINE_MUSIC_GEN_FAILED' });
    expect(spawnCalls).toHaveLength(0);
  });
});

describe('isEngineReady', () => {
  it('reflects each engine resolver independently', () => {
    h.musicgenPython = '/fake/venv-musicgen/bin/python3';
    h.audioldm2Python = null;
    expect(isEngineReady('musicgen')).toBe(true);
    expect(isEngineReady('audioldm2')).toBe(false);
  });
});

describe('isEngineHealthy', () => {
  it('reports a half-built venv as unhealthy even though the interpreter exists', async () => {
    // The exact state a killed/failed install leaves behind: `python` is there,
    // the packages are not. isEngineReady says yes; isEngineHealthy must not.
    h.probeOk = false;
    expect(isEngineReady('musicgen')).toBe(true);
    expect(await isEngineHealthy('musicgen')).toBe(false);
  });

  it('reports a fully-installed venv as healthy', async () => {
    expect(await isEngineHealthy('musicgen')).toBe(true);
    expect(h.probeCalls[0]).toMatchObject({ file: '/fake/venv-musicgen/bin/python3' });
    expect(h.probeCalls[0].args[0]).toBe('-c');
  });

  it('skips the probe entirely when no interpreter is resolved', async () => {
    h.audioldm2Python = null;
    expect(await isEngineHealthy('audioldm2')).toBe(false);
    expect(h.probeCalls).toHaveLength(0);
  });

  it('caches the verdict so repeat readiness checks do not respawn python', async () => {
    expect(await isEngineHealthy('musicgen')).toBe(true);
    expect(await isEngineHealthy('musicgen')).toBe(true);
    expect(h.probeCalls).toHaveLength(1);
  });

  it('re-probes with refresh so a repair install is not blocked by a stale verdict', async () => {
    h.probeOk = false;
    expect(await isEngineHealthy('musicgen')).toBe(false);
    // The install just rebuilt the venv — a cached `false` must not stick.
    h.probeOk = true;
    expect(await isEngineHealthy('musicgen', { refresh: true })).toBe(true);
    expect(h.probeCalls).toHaveLength(2);
  });

  it('tracks each engine independently', async () => {
    expect(await isEngineHealthy('musicgen')).toBe(true);
    h.probeOk = false;
    expect(await isEngineHealthy('audioldm2')).toBe(false);
    expect(await isEngineHealthy('musicgen')).toBe(true);
  });
});

describe('ENGINES healthProbe parity', () => {
  it('every engine declares an import probe', () => {
    // A new engine without one silently falls back to "the interpreter file
    // exists", which is the exact check isEngineHealthy was added to replace.
    for (const engine of Object.values(ENGINES)) {
      expect(typeof engine.healthProbe, `${engine.id} healthProbe`).toBe('string');
      expect(engine.healthProbe.length).toBeGreaterThan(0);
    }
  });
});

describe('generateMusic venv-health gate', () => {
  it('returns the install hint instead of spawning into a half-built venv', async () => {
    // The interpreter is present, the packages are not — without the health gate
    // the sidecar spawns and dies with a raw Python ImportError traceback.
    h.probeOk = false;
    await expect(generateMusic({ prompt: 'a calm piano bed', engine: 'musicgen' }))
      .rejects.toMatchObject({ status: 503, code: 'PIPELINE_MUSIC_RUNTIME_MISSING' });
    expect(spawnCalls).toHaveLength(0);
  });

  it('still generates when the venv is healthy', async () => {
    const res = await generateMusic({ prompt: 'a calm piano bed', engine: 'musicgen' });
    expect(res.filename).toMatch(/^music-gen-.*\.wav$/);
    expect(spawnCalls).toHaveLength(1);
  });
});
describe('isEnginePlatformSupported', () => {
  it('treats an engine with no requiresPlatform as portable', () => {
    expect(ENGINES.audioldm2.requiresPlatform).toBeUndefined();
    h.osPlatform = 'win32';
    h.osArch = 'x64';
    expect(isEnginePlatformSupported('audioldm2')).toBe(true);
    expect(enginePlatformLabel('audioldm2')).toBeNull();
  });

  it('allows MusicGen only on Apple Silicon', () => {
    // MLX has no Windows/Linux build, so the setup script skips and exits 0 —
    // which the install route used to report as "installer exited 0 but still
    // not available", indistinguishable from a broken install.
    expect(ENGINES.musicgen.requiresPlatform).toMatchObject({ platform: 'darwin', arch: 'arm64' });
    expect(isEnginePlatformSupported('musicgen')).toBe(true);

    h.osPlatform = 'win32';
    h.osArch = 'x64';
    expect(isEnginePlatformSupported('musicgen')).toBe(false);

    // Intel Mac: right OS, wrong silicon.
    h.osPlatform = 'darwin';
    h.osArch = 'x64';
    expect(isEnginePlatformSupported('musicgen')).toBe(false);
  });

  it('exposes a human-readable requirement for the UI', () => {
    expect(enginePlatformLabel('musicgen')).toContain('Apple Silicon');
  });

  it('never reports an unsupported host as healthy, and never spawns a probe there', async () => {
    h.osPlatform = 'win32';
    h.osArch = 'x64';
    h.probeOk = true;
    expect(await isEngineHealthy('musicgen')).toBe(false);
    expect(h.probeCalls).toHaveLength(0);
  });

  it('refuses to generate on an unsupported host instead of spawning the sidecar', async () => {
    h.osPlatform = 'win32';
    h.osArch = 'x64';
    await expect(generateMusic({ prompt: 'a calm piano bed', engine: 'musicgen' }))
      .rejects.toMatchObject({ status: 503, code: 'PIPELINE_MUSIC_RUNTIME_MISSING' });
    expect(spawnCalls).toHaveLength(0);
  });
});

describe('instrumental lyrics fallback', () => {
  const base = { pythonPath: '/venv/bin/python3', prompt: 'cinematic electronic instrumental', durationSec: 60, outputPath: '/tmp/out.wav' };
  const lyricsArg = (args) => args[args.indexOf('--lyrics') + 1];

  it('substitutes a documented structure-tag sheet when MiniMax Music 3 gets no lyrics', () => {
    // The checkpoint's tokenize step raises on an empty string, so an
    // instrumental prompt used to die with "`lyrics` must be a non-empty
    // string" after the model had already loaded.
    for (const lyrics of [undefined, '', '   ', '\n\t ']) {
      const { args } = buildSidecarArgs({ ...base, engineId: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3', lyrics });
      expect(lyricsArg(args), `lyrics=${JSON.stringify(lyrics)}`).toBe(buildMinimaxInstrumentalLyrics(60));
    }
  });

  it('sizes the substituted sheet to the render duration, not a fixed one-tag stub', () => {
    // `audio_duration` is only a ceiling for this engine — the global LLM ends
    // the piece on its own, paced by the sheet's section count. A single
    // [instrumental] tag is one section, which is why a 60s ask returned 25s.
    const lyricsFor = (durationSec) => lyricsArg(
      buildSidecarArgs({ ...base, engineId: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3', durationSec, lyrics: '' }).args,
    );
    const sections = (sheet) => sheet.split('\n').length;
    expect(sections(lyricsFor(20))).toBeLessThan(sections(lyricsFor(60)));
    expect(sections(lyricsFor(60))).toBeLessThan(sections(lyricsFor(240)));
  });

  it('never touches lyrics the caller actually supplied', () => {
    const words = '[verse]\nExample words here';
    const { args } = buildSidecarArgs({ ...base, engineId: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3', lyrics: words });
    expect(lyricsArg(args)).toBe(words);
  });

  it('leaves ACE-Step empty — it renders an instrumental from empty lyrics itself', () => {
    expect(ENGINES.acestep.instrumentalLyrics).toBeUndefined();
    const { args } = buildSidecarArgs({ ...base, engineId: 'acestep', repo: 'ACE-Step/ACE-Step-v1-3.5B', lyrics: '' });
    expect(lyricsArg(args)).toBe('');
  });
});

describe('buildMinimaxInstrumentalLyrics', () => {
  const tags = (sheet) => sheet.split('\n');

  it('brackets every line and opens on [intro] / closes on [outro]', () => {
    const lines = tags(buildMinimaxInstrumentalLyrics(60));
    for (const line of lines) expect(line).toMatch(/^\[[a-z]+\]$/);
    expect(lines[0]).toBe('[intro]');
    expect(lines.at(-1)).toBe('[outro]');
  });

  it('uses only tags the model card documents, and none that imply a vocal', () => {
    // Section tags are a fixed vocabulary; [verse]/[chorus] would coax the
    // model into singing over what the user asked to be an instrumental.
    const documented = new Set(['intro', 'instrumental', 'bridge', 'solo', 'outro']);
    for (const seconds of [1, 30, 60, 120, 300]) {
      for (const line of tags(buildMinimaxInstrumentalLyrics(seconds))) {
        expect(documented, `${seconds}s → ${line}`).toContain(line.slice(1, -1));
      }
    }
  });

  it('grows monotonically with duration and always keeps a body section', () => {
    let previous = 0;
    for (const seconds of [1, 20, 60, 120, 240, 300]) {
      const count = tags(buildMinimaxInstrumentalLyrics(seconds)).length;
      expect(count, `${seconds}s`).toBeGreaterThanOrEqual(previous);
      // intro + at least one body + outro
      expect(count, `${seconds}s`).toBeGreaterThanOrEqual(3);
      previous = count;
    }
  });

  it('clamps into the engine window instead of throwing on junk input', () => {
    // Mirrors clampDuration's contract — the route validates shape, this
    // guards the math, so a non-finite duration falls back to the default.
    for (const bad of [undefined, null, NaN, 'sixty', -5, 1e9]) {
      expect(() => buildMinimaxInstrumentalLyrics(bad)).not.toThrow();
      expect(tags(buildMinimaxInstrumentalLyrics(bad)).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('caps the sheet so a 5-minute render does not emit an unbounded tag wall', () => {
    expect(tags(buildMinimaxInstrumentalLyrics(300)).length).toBeLessThanOrEqual(14);
  });
});
