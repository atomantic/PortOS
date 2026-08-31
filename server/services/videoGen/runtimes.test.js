import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pinPlatform } from '../../lib/testHelper.js';

const runtimeMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  spawn: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => ({
  ...await importOriginal(),
  existsSync: runtimeMocks.existsSync,
}));
vi.mock('../../lib/childProcess.js', async (importOriginal) => ({
  ...await importOriginal(),
  spawn: runtimeMocks.spawn,
}));

import {
  BYOV_RUNTIME_INFO, BYOV_VIDEO_RUNTIMES, MINIMAX_H3_CUDA_OFFLOAD_PROFILES,
  byovRuntimeLoraCapable, invalidateByovLoraCapabilityCache, invalidateByovReadyCache,
  isByovRuntimeCurrent, isByovRuntimeReady, isPinnedSourceStatusClean, modelAnchorsLastFrame,
  resolveByovRuntimeLoraCapable, runtimeIsCacheOnly, runtimeNeedsProcessGroupKill,
  routesToWindowsHelper, LTX25_EXPECTED_REVISION,
} from './runtimes.js';

const REVISION = 'fcd9e9b79a1d6018d91ac477c0968de1fa067e49';

const statusChild = (stdout) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });
  return child;
};

// Boolean venv-probe child. stdout is never piped by runVenvProbe, so this has
// none; stderr is, because that is where the probes write their diagnostics.
const exitChild = (code, stderr = '') => {
  const child = new EventEmitter();
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.kill = vi.fn();
  queueMicrotask(() => {
    // The real stream is switched to utf8, so it hands over decoded strings.
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', code);
  });
  return child;
};

// Run `probe`, returning every console.error line it produced. Spying rather
// than asserting on a mock keeps the real console quiet during the suite.
const captureProbeLogs = async (probe) => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await probe();
  const lines = spy.mock.calls.map(([line]) => line);
  spy.mockRestore();
  return { result, lines };
};

beforeEach(() => {
  invalidateByovReadyCache();
  invalidateByovLoraCapabilityCache();
  runtimeMocks.existsSync.mockReset().mockReturnValue(true);
  runtimeMocks.spawn.mockReset();
});

describe('retired runtime filtering', () => {
  it('does not advertise legacy Hunyuan support to the video UI', () => {
    expect(BYOV_RUNTIME_INFO).not.toHaveProperty('hunyuan');
    expect(BYOV_VIDEO_RUNTIMES.has('hunyuan')).toBe(false);
  });
});

describe('MiniMax H3 Ref2VA runtime', () => {
  it('uses the signed user-local mere.run install and PortOS HF downloader', () => {
    expect(BYOV_RUNTIME_INFO.minimax_h3_ref2va).toMatchObject({
      installEnvVar: 'INSTALL_MERERUN',
      expectedVersion: '0.47.0',
      probeArgs: ['--version'],
      cacheOnly: true,
      killProcessGroup: true,
      hfDownloadPython: false,
    });
  });

  it('accepts only the pinned mere.run version as current', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => statusChild('0.47.0\n'));
    await expect(isByovRuntimeCurrent('minimax_h3_ref2va')).resolves.toBe(true);
    expect(runtimeMocks.spawn).toHaveBeenCalledWith(
      BYOV_RUNTIME_INFO.minimax_h3_ref2va.venvPython,
      ['--version'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
    );

    runtimeMocks.spawn.mockImplementationOnce(() => statusChild('0.46.1\n'));
    await expect(isByovRuntimeCurrent('minimax_h3_ref2va')).resolves.toBe(false);
  });
});

describe('isPinnedSourceStatusClean', () => {
  it('accepts the exact revision when the scoped source package is clean', () => {
    expect(isPinnedSourceStatusClean([
      `# branch.oid ${REVISION}`,
      '# branch.head (detached)',
      '',
    ].join('\n'), REVISION)).toBe(true);
  });

  it.each([
    [`# branch.oid ${'0'.repeat(40)}\n# branch.head main\n`, 'stale revision'],
    [`# branch.oid ${REVISION}\n1 .M N... 100644 100644 100644 abc abc minimax_h3_mlx/pipeline.py\n`, 'tracked edit'],
    [`# branch.oid ${REVISION}\n? minimax_h3_mlx/shadow.py\n`, 'untracked module'],
  ])('rejects a %s', (stdout) => {
    expect(isPinnedSourceStatusClean(stdout, REVISION)).toBe(false);
  });
});

describe('isByovRuntimeReady', () => {
  it('does not execute the import probe when the H3 source checkout is stale', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => statusChild([
      `# branch.oid ${'0'.repeat(40)}`,
      '# branch.head main',
      '',
    ].join('\n')));

    await expect(isByovRuntimeReady('minimax_h3')).resolves.toBe(false);

    expect(runtimeMocks.spawn).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.spawn.mock.calls[0][0]).toBe('git');
  });
});

describe('venv probe diagnostics', () => {
  it('pipes stderr (never stdout) and logs the failing probe’s own diagnostic', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => exitChild(
      1, 'ModuleNotFoundError: No module named "diffusers.modular_pipelines.minimax_h3"\n',
    ));

    const { result, lines } = await captureProbeLogs(() => isByovRuntimeReady('minimax_h3_cuda'));

    expect(result).toBe(false);
    expect(runtimeMocks.spawn.mock.calls[0][2].stdio).toEqual(['ignore', 'ignore', 'pipe']);
    // Decoding on the stream is what keeps a multi-byte character split across
    // two chunks from arriving as U+FFFD.
    expect(runtimeMocks.spawn.mock.results[0].value.stderr.setEncoding).toHaveBeenCalledWith('utf8');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('minimax_h3_cuda readiness');
    expect(lines[0]).toContain('exited 1');
    expect(lines[0]).toContain('No module named "diffusers.modular_pipelines.minimax_h3"');
    expect(lines[0]).not.toContain('\n');
  });

  it('says so explicitly when a failing probe wrote nothing at all', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => exitChild(1));

    const { result, lines } = await captureProbeLogs(() => isByovRuntimeReady('minimax_h3_cuda'));

    // "Failed and said nothing" must not go silent — that reads identically to
    // "the probe never ran", which is the state this whole change removes.
    expect(result).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('exited 1');
    expect(lines[0]).toContain('no stderr output');
  });

  it('logs and resolves false when the venv python cannot be spawned', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter();
      child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
      child.kill = vi.fn();
      // Node's real message interpolates the interpreter path, as here.
      const err = Object.assign(new Error('spawn /home/example/.portos/x/.venv/bin/python3 ENOENT'), {
        code: 'ENOENT',
      });
      queueMicrotask(() => child.emit('error', err));
      return child;
    });

    const { result, lines } = await captureProbeLogs(() => isByovRuntimeReady('minimax_h3_cuda'));

    expect(result).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('could not be spawned (ENOENT)');
    // The label already says which runtime this was; the venv path would only
    // add the OS username to the log.
    expect(lines[0]).not.toContain('/home/example');
  });

  it('attributes the line to the LoRA probe without calling its verdict a fault', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => exitChild(
      1, 'ImportError: PortOS MiniMax H3 LoRA adapter is unavailable\n',
    ));

    const { result, lines } = await captureProbeLogs(() => resolveByovRuntimeLoraCapable('minimax_h3'));

    // A runtime that fails the optional applicator probe is the documented
    // normal answer, not a broken install — so the reason is surfaced, but not
    // under the failure icon.
    expect(result).toBe(false);
    expect(lines[0]).toContain('minimax_h3 LoRA-capability');
    expect(lines[0]).toContain('PortOS MiniMax H3 LoRA adapter is unavailable');
    expect(lines[0].startsWith('❌')).toBe(false);
  });
});

// H3's DiT is quantized, so whether a LoRA can ride along is a property of the
// installed checkout, not the model entry — hence a probe rather than a
// hardcoded predicate. The gate must fail CLOSED until that probe has answered.
describe('MiniMax H3 LoRA capability', () => {
  it('reports capable when the runtime plus adapter pass the quant-aware probe', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => exitChild(0));
    await expect(resolveByovRuntimeLoraCapable('minimax_h3')).resolves.toBe(true);
    expect(byovRuntimeLoraCapable('minimax_h3')).toBe(true);
  });

  it('reports not capable when the runtime fails the LoRA applicator probe', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => exitChild(1));
    // Captured, not asserted on: the verdict now writes a line, and letting it
    // through would print a scary-looking probe log during an unrelated test.
    const { result } = await captureProbeLogs(() => resolveByovRuntimeLoraCapable('minimax_h3'));
    expect(result).toBe(false);
    expect(byovRuntimeLoraCapable('minimax_h3')).toBe(false);
  });

  it('logs a capped single-line tail when a probe writes stderr', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runtimeMocks.spawn.mockImplementationOnce(() => exitChild(
      1, `${'x'.repeat(5000)}\nmissing quant-aware applicator`,
    ));

    await expect(resolveByovRuntimeLoraCapable('minimax_h3')).resolves.toBe(false);
    const [message] = errorSpy.mock.calls[0] || [];
    errorSpy.mockRestore();

    expect(runtimeMocks.spawn.mock.calls[0][2].stdio).toEqual(['ignore', 'ignore', 'pipe']);
    expect(message).toContain('missing quant-aware applicator');
    expect(message).not.toContain('\n');
    // Bound the retained tail, not the label prefix, which varies per runtime.
    expect(message.length).toBeLessThanOrEqual(4096 + 128);
  });

  it('caches both outcomes so the probe runs once per process', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => exitChild(0));
    await resolveByovRuntimeLoraCapable('minimax_h3');
    await resolveByovRuntimeLoraCapable('minimax_h3');
    expect(runtimeMocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight probe across concurrent callers', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => exitChild(0));
    const [a, b] = await Promise.all([
      resolveByovRuntimeLoraCapable('minimax_h3'),
      resolveByovRuntimeLoraCapable('minimax_h3'),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(runtimeMocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not cache a verdict for an uninstalled runtime', async () => {
    runtimeMocks.existsSync.mockReturnValue(false);
    await expect(resolveByovRuntimeLoraCapable('minimax_h3')).resolves.toBe(false);
    expect(runtimeMocks.spawn).not.toHaveBeenCalled();

    runtimeMocks.existsSync.mockReturnValue(true);
    runtimeMocks.spawn.mockImplementationOnce(() => exitChild(0));
    await expect(resolveByovRuntimeLoraCapable('minimax_h3')).resolves.toBe(true);
  });

  it('reads as not capable while the probe is still in flight, and warms the cache', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => exitChild(0));
    // Cold read: unknown must NOT be mistaken for a probed `true`.
    expect(byovRuntimeLoraCapable('minimax_h3')).toBe(false);
    // ...but it kicked off the probe, so the next read reflects the truth.
    await resolveByovRuntimeLoraCapable('minimax_h3');
    expect(byovRuntimeLoraCapable('minimax_h3')).toBe(true);
    expect(runtimeMocks.spawn).toHaveBeenCalledTimes(1);
  });

  it.each(['ltx2', 'ltx25', 'wan22'])('never probes %s, which has no LoRA runtime path', async (runtime) => {
    await expect(resolveByovRuntimeLoraCapable(runtime)).resolves.toBe(false);
    expect(byovRuntimeLoraCapable(runtime)).toBe(false);
    expect(runtimeMocks.spawn).not.toHaveBeenCalled();
  });
});

// One declaration feeds three consumers: buildArgs (which forwards the last
// frame), the last-image resize in local.js, and the client's advisory note via
// the `lastFrameAnchored` field listVideoModels() decorates onto each model.
describe('modelAnchorsLastFrame', () => {
  it.each([
    ['ltx2', true],
    ['ltx25', true],
    ['minimax_h3', true],
    // Anchoring is a property of the fl2va checkpoint, not of the runner in
    // front of it, so the CUDA path must agree with the MLX one.
    ['minimax_h3_cuda', true],
    ['mlx_video', false],
    ['wan22', false],
    ['fastvideo', false],
  ])('reports %s as %s', (runtime, anchored) => {
    expect(modelAnchorsLastFrame({ runtime })).toBe(anchored);
  });

  it('treats a missing model or runtime as not anchored', () => {
    expect(modelAnchorsLastFrame(null)).toBe(false);
    expect(modelAnchorsLastFrame({})).toBe(false);
  });
});

describe('routesToWindowsHelper', () => {
  it.each(['win32', 'linux'])('routes legacy CUDA video through the helper on %s', (platform) => {
    const restorePlatform = pinPlatform(platform);
    try {
      expect(routesToWindowsHelper({ runtime: 'cuda_video' })).toBe(true);
    } finally {
      restorePlatform();
    }
  });

  it('keeps macOS and BYOV runtimes out of the legacy helper', () => {
    const restorePlatform = pinPlatform('darwin');
    try {
      expect(routesToWindowsHelper({ runtime: 'cuda_video' })).toBe(false);
    } finally {
      restorePlatform();
    }
    expect(routesToWindowsHelper({ runtime: 'minimax_h3_cuda' })).toBe(false);
  });

  it('does not send a Linux custom MLX entry through the fixed-repo helper', () => {
    const restorePlatform = pinPlatform('linux');
    try {
      expect(routesToWindowsHelper({ runtime: 'mlx_video', repo: 'example-org/custom-video' })).toBe(false);
    } finally {
      restorePlatform();
    }
  });
});

describe('minimax_h3_cuda runtime registration', () => {
  const info = BYOV_RUNTIME_INFO.minimax_h3_cuda;

  it('is a BYOV runtime with its own venv, distinct from the MLX port', () => {
    expect(BYOV_VIDEO_RUNTIMES.has('minimax_h3_cuda')).toBe(true);
    expect(info.installEnvVar).toBe('INSTALL_MINIMAX_H3_CUDA');
    // Sharing a venv with the MLX port would let one install's `pip sync`
    // silently uninstall the other's packages.
    expect(info.venvPython).not.toBe(BYOV_RUNTIME_INFO.minimax_h3.venvPython);
    expect(info.repoDir).not.toBe(BYOV_RUNTIME_INFO.minimax_h3.repoDir);
  });

  it('resolves the interpreter by venv layout, not by platform name', () => {
    // A Windows venv puts python under Scripts\, a POSIX one under bin/. This
    // is the whole reason the constant can't be the MLX port's bin/python3
    // literal — that path never exists on the platform this runtime targets.
    const expected = process.platform === 'win32'
      ? ['Scripts', 'python.exe']
      : ['bin', 'python3'];
    for (const part of expected) expect(info.venvPython).toContain(part);
  });

  it('probes for CUDA and the H3 integration, not merely for an importable diffusers', () => {
    // Each of these is a distinct way the install can look complete and not be:
    // a CPU-only torch wheel, a diffusers release predating PR #14355, or a
    // missing torchao (int8 is what makes the 133 GB bf16 pair fit at all).
    expect(info.probeArgs).toBeUndefined();
    expect(info.importProbe).toContain('MiniMaxH3Transformer3DModel');
    expect(info.importProbe).toContain('torchao');
    expect(info.importProbe).toContain('torch.cuda.is_available()');
  });

  it('declares no revision pin or LoRA probe — it runs distributions, not a checkout', () => {
    // `expectedRevision`/`sourcePath` drive the clean-checkout gate, which has
    // nothing to verify here; `loraProbeArgs` absent is the correct "this
    // runtime can never take LoRAs", matching wan22 / fastvideo.
    expect(info.expectedRevision).toBeUndefined();
    expect(info.sourcePath).toBeUndefined();
    expect(info.loraProbeArgs).toBeUndefined();
  });

  it('never reports LoRA capability, even after a probe attempt', async () => {
    expect(byovRuntimeLoraCapable('minimax_h3_cuda')).toBe(false);
    await expect(resolveByovRuntimeLoraCapable('minimax_h3_cuda')).resolves.toBe(false);
    // No probe child may be spawned for a runtime with no loraProbeArgs.
    expect(runtimeMocks.spawn).not.toHaveBeenCalled();
  });
});

describe('ltx25_cuda runtime registration', () => {
  const info = BYOV_RUNTIME_INFO.ltx25_cuda;

  it('registers the official cache-only CUDA pipeline in its own venv', () => {
    expect(BYOV_VIDEO_RUNTIMES.has('ltx25_cuda')).toBe(true);
    expect(info.installEnvVar).toBe('INSTALL_LTX25_CUDA');
    expect(info.repoUrl).toBe('https://github.com/Lightricks/LTX-2');
    expect(info.venvPython).not.toBe(BYOV_RUNTIME_INFO.ltx25.venvPython);
    expect(info.importProbe).toContain('DistilledPipeline');
    expect(info.importProbe).toContain('torch.cuda.is_available()');
    expect(info.importProbe).toContain('2.10.0+cu128');
    expect(info.cacheOnly).toBe(true);
    expect(info.killProcessGroup).toBe(true);
  });

  it('keeps the cache contract aligned with the Python runner', () => {
    const runner = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'generate_ltx25_cuda.py'),
      'utf8',
    );
    for (const relative of [
      'diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors',
      'text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors',
      'vae/ltx-2.5-video-vae-bf16.safetensors',
      'vae/ltx-2.5-audio-vae-bf16.safetensors',
      'model_patches/ltx-2.5-duration-head-bf16.safetensors',
      'latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors',
    ]) {
      expect(runner).toContain(relative);
    }
    expect(runner).toContain('local_files_only=True');
    expect(runner).toContain('PYTORCH_CUDA_ALLOC_CONF');
    expect(runner).toContain('OffloadMode.DISK');
    expect(runner).not.toContain('SafetensorsStateDictLoader.load =');
    expect(runner).not.toContain('pipe.prompt_encoder =');
  });
});

// The JS list exists so the server can reject a bad registry `offloadProfile`
// with a stable code instead of an opaque non-zero child exit — which only
// works while it agrees with the argparse `choices=` that actually enforces it.
// Hand-synced across a language boundary is the established shape here, so pin
// it rather than leave the two free to drift.
describe('MiniMax H3 CUDA offload profiles', () => {
  it('matches OFFLOAD_PROFILES in the Python runner', () => {
    const runner = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'generate_minimax_h3_cuda.py'),
      'utf8',
    );
    const declared = runner.match(/^OFFLOAD_PROFILES = \(([^)]*)\)/m);
    expect(declared).not.toBeNull();
    const fromPython = [...declared[1].matchAll(/"([^"]+)"/g)].map(([, value]) => value);
    expect(fromPython).toEqual([...MINIMAX_H3_CUDA_OFFLOAD_PROFILES]);
  });
});

describe('fastvideo runtime registration', () => {
  const info = BYOV_RUNTIME_INFO.fastvideo;

  it('is a BYOV runtime with its own venv', () => {
    expect(BYOV_VIDEO_RUNTIMES.has('fastvideo')).toBe(true);
    expect(info.installEnvVar).toBe('INSTALL_FASTVIDEO');
    for (const part of ['.portos', 'fastvideo', '.venv']) expect(info.venvPython).toContain(part);
    for (const part of ['.portos', 'fastvideo']) expect(info.repoDir).toContain(part);
  });

  it('probes for fastvideo and mlx.core', () => {
    expect(info.importProbe).toContain('fastvideo');
    expect(info.importProbe).toContain('mlx.core');
  });

  it('never reports LoRA capability', async () => {
    expect(byovRuntimeLoraCapable('fastvideo')).toBe(false);
    await expect(resolveByovRuntimeLoraCapable('fastvideo')).resolves.toBe(false);
  });
});

// Execution facts read off the registry rather than re-derived from a runtime id
// at the spawn site, so a new cache-only runtime is a table line, not an edit to
// the child-spawn path. Absent means off, as with every other optional key here.
describe('runtime execution flags', () => {
  it('reports cache-only for exactly the runners that never touch the network', () => {
    expect(runtimeIsCacheOnly('minimax_h3')).toBe(true);
    expect(runtimeIsCacheOnly('minimax_h3_cuda')).toBe(true);
    expect(runtimeIsCacheOnly('ltx25_cuda')).toBe(true);
    expect(runtimeIsCacheOnly('wan22_cuda')).toBe(true);
    expect(runtimeIsCacheOnly('ltx2')).toBe(false);
    expect(runtimeIsCacheOnly('wan22')).toBe(false);
    expect(runtimeIsCacheOnly('fastvideo')).toBe(false);
    expect(runtimeIsCacheOnly(undefined)).toBe(false);
  });

  it('reports group-kill for the runners that spawn children of their own', () => {
    expect(runtimeNeedsProcessGroupKill('wan22')).toBe(true);
    expect(runtimeNeedsProcessGroupKill('fastvideo')).toBe(true);
    expect(runtimeNeedsProcessGroupKill('minimax_h3')).toBe(true);
    expect(runtimeNeedsProcessGroupKill('minimax_h3_cuda')).toBe(true);
    expect(runtimeNeedsProcessGroupKill('ltx25_cuda')).toBe(true);
    expect(runtimeNeedsProcessGroupKill('wan22_cuda')).toBe(true);
    expect(runtimeNeedsProcessGroupKill('ltx2')).toBe(false);
    expect(runtimeNeedsProcessGroupKill('nope')).toBe(false);
  });
});

// A pin bump is where the frame-one anchor silently breaks: the LTX-2.5 fork
// samples image-to-video with the ancestral (SDE) Euler loop, and a revision
// whose loop does not re-apply the conditioning mask after its renoise renders a
// coherent clip that has nothing to do with the supplied image (#5422). The
// helper enforces the invariant against the live pin at render time; this is the
// tripwire that makes a reviewer look BEFORE that reaches a user machine.
describe('LTX-2.5 i2v anchor pin verification', () => {
  it('pins a revision whose ancestral sampler was read for anchor preservation', () => {
    expect(BYOV_RUNTIME_INFO.ltx25.i2vAnchorVerifiedRevision).toBe(LTX25_EXPECTED_REVISION);
  });

  // Nothing else declares it, so the field never reads as "verified" for a
  // runtime whose sampler was never inspected.
  it('claims verification for no other runtime', () => {
    const claimed = Object.values(BYOV_RUNTIME_INFO)
      .filter((info) => info.i2vAnchorVerifiedRevision).map((info) => info.id);
    expect(claimed).toEqual(['ltx25']);
  });
});
