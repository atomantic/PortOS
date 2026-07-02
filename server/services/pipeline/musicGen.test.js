import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, readdir } from 'fs/promises';
import { writeFileSync, mkdtempSync } from 'fs';

// ---- Pure-helper tests (no mocks needed) ---------------------------------
import {
  buildMusicGenArgs,
  buildSidecarArgs,
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
    expect(Object.keys(ENGINES).sort()).toEqual(['acestep', 'audioldm2', 'musicgen']);
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
  const base = {
    pythonPath: '/venv/bin/python3',
    repo: 'facebook/musicgen-medium',
    prompt: 'tense cinematic synth',
    durationSec: 10,
    outputPath: '/data/music/music-gen-abc.wav',
  };

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
}));
// Set after the top-level imports resolve; the fileUtils mock reads it through
// a getter so the (eagerly-built) PATHS object always reflects the final value.
h.testDir = mkdtempSync(join(tmpdir(), 'musicgen-test-'));
const TEST_DIR = h.testDir;
const spawnCalls = h.spawnCalls;

vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process');
  return {
    ...actual,
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

vi.mock('../../lib/hfToken.js', () => ({ hfTokenEnv: async () => ({}) }));

// Venv resolvers — flip readiness per engine per test.
vi.mock('../../lib/pythonSetup.js', async () => {
  const actual = await vi.importActual('../../lib/pythonSetup.js');
  return {
    ...actual,
    resolveMusicgenPython: () => h.musicgenPython,
    resolveAudioldm2Python: () => h.audioldm2Python,
  };
});

const { generateMusic } = await import('./musicGen.js');

beforeEach(() => {
  h.spawnCalls.length = 0;
  h.mockExitCode = 0;
  h.mockWriteOutput = true;
  h.mockStdout = 'STAGE:done\nRESULT:{"output":"x","durationSec":12.5,"sampleRate":32000}\n';
  h.musicgenPython = '/fake/venv-musicgen/bin/python3';
  h.audioldm2Python = '/fake/venv-audioldm2/bin/python3';
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
