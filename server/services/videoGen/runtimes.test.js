import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pinPlatform, resolveTestPython } from '../../lib/testHelper.js';

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
  resolveA2vLoraStageCapable, a2vLoraStageCapable,
  resolveByovRuntimeLoraCapable, resolveMiniMaxH3MlxSpeedCapable, runtimeIsCacheOnly, runtimeNeedsProcessGroupKill, runtimeUsesMlx,
  routesToWindowsHelper, warmByovLoraCapabilities, LTX25_EXPECTED_REVISION,
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

describe('Wan 2.2 CUDA locked currency', () => {
  const python = resolveTestPython();

  it.skipIf(!python)('checks transitive metadata, missing packages, Python minor and Conda before declaring a runtime current', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-cuda-currency-'));
    try {
      const lock = join(root, 'runtime.lock.txt');
      writeFileSync(lock, [
        '--index-url https://pypi.org/simple',
        'portos-currency-direct==1.0 \\',
        `    --hash=sha256:${'0'.repeat(64)}`,
        '    # via runtime',
        'portos-currency-transitive==2.0 \\',
        `    --hash=sha256:${'1'.repeat(64)}`,
        '',
      ].join('\n'));
      const direct = join(root, 'portos_currency_direct-1.0.dist-info');
      const transitive = join(root, 'portos_currency_transitive-2.0.dist-info');
      mkdirSync(direct);
      mkdirSync(transitive);
      writeFileSync(join(direct, 'METADATA'), 'Name: portos-currency-direct\nVersion: 1.0\n');
      const metadata = join(transitive, 'METADATA');
      writeFileSync(metadata, 'Name: portos-currency-transitive\nVersion: 2.0\n');
      const probe = (version = '3.11', base = root) => spawnSync(python, ['-c', `
import importlib.metadata, re, sys
from pathlib import Path
sys.path.insert(0, sys.argv[2])
sys.version_info = tuple(map(int, sys.argv[3].split('.')))
sys.base_prefix = sys.argv[4]
${BYOV_RUNTIME_INFO.wan22_cuda.currencyProbeArgs[1]}`, lock, root, version, base], { encoding: 'utf8', timeout: 10000 });

      expect(probe().status).toBe(0);
      writeFileSync(metadata, 'Name: portos-currency-transitive\nVersion: 1.0\n');
      expect(probe().status).toBe(78);
      rmSync(transitive, { recursive: true });
      expect(probe().status).toBe(78);
      mkdirSync(transitive);
      writeFileSync(metadata, 'Name: portos-currency-transitive\nVersion: 2.0\n');
      expect(probe('3.10').status).toBe(78);
      const conda = join(root, 'conda-base');
      mkdirSync(join(conda, 'conda-meta'), { recursive: true });
      expect(probe('3.11', conda).status).toBe(78);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('offers upgrade for a stale lock even after a successful readiness result was cached', async () => {
    runtimeMocks.spawn.mockImplementation(() => exitChild(0));
    await expect(isByovRuntimeReady('wan22_cuda')).resolves.toBe(true);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      runtimeMocks.spawn.mockImplementation(() => exitChild(78));
      const current = await captureProbeLogs(() => isByovRuntimeCurrent('wan22_cuda'));
      expect(current).toEqual({ result: false, lines: [] });
      await expect(isByovRuntimeReady('wan22_cuda')).resolves.toBe(false);
      expect(logs).toHaveBeenCalledWith(expect.stringContaining('needs a dependency upgrade'));
      expect(runtimeMocks.spawn.mock.calls.at(-1)[1].at(-1)).toMatch(
        /requirements-wan22-cuda-(windows|linux)\.lock\.txt$/,
      );
    } finally { logs.mockRestore(); }
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

describe('MLX LightX2V runtime admission', () => {
  it('requires the actual clean Git pin before the sampler seam probe can admit the profile', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => statusChild(`# branch.oid ${'0'.repeat(40)}\n`));
    await expect(resolveMiniMaxH3MlxSpeedCapable()).resolves.toBe(false);
    expect(runtimeMocks.spawn).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.spawn.mock.calls[0][0]).toBe('git');

    runtimeMocks.spawn.mockClear();
    runtimeMocks.spawn.mockImplementationOnce(() => statusChild(`# branch.oid ${REVISION}\n`))
      .mockImplementationOnce(() => exitChild(0));
    await expect(resolveMiniMaxH3MlxSpeedCapable()).resolves.toBe(true);
    expect(runtimeMocks.spawn.mock.calls[1][1]).toEqual([
      expect.stringContaining('_minimax_h3_mlx_lightx2v.py'), '--probe',
      BYOV_RUNTIME_INFO.minimax_h3.repoDir, REVISION,
    ]);
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

  // What the model-list routes await so their payloads never ship the cold read
  // above as if it were a probed verdict. Both route suites double this
  // function, so that it reaches the gated runtime at all is only checked here.
  it('makes the sync accessor authoritative once it resolves', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => exitChild(0));
    await warmByovLoraCapabilities();
    expect(byovRuntimeLoraCapable('minimax_h3')).toBe(true);
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

  it('uses a distribution/scheduler/quantized-LoRA probe instead of a checkout revision pin', () => {
    expect(info.expectedRevision).toBeUndefined();
    expect(info.sourcePath).toBeUndefined();
    expect(info.loraProbeArgs[0]).toMatch(/minimax_h3_cuda_lora\.py$/);
    expect(info.loraProbeArgs[1]).toBe('--probe');
  });

  it('keeps CUDA adapters unavailable until its probe returns a positive verdict', async () => {
    runtimeMocks.existsSync.mockReturnValue(false);
    expect(byovRuntimeLoraCapable('minimax_h3_cuda')).toBe(false);
    await expect(resolveByovRuntimeLoraCapable('minimax_h3_cuda')).resolves.toBe(false);
    expect(runtimeMocks.spawn).not.toHaveBeenCalled();
    runtimeMocks.existsSync.mockReturnValue(true);
    runtimeMocks.spawn.mockImplementation(() => exitChild(0));
    await expect(resolveByovRuntimeLoraCapable('minimax_h3_cuda')).resolves.toBe(true);
    expect(byovRuntimeLoraCapable('minimax_h3_cuda')).toBe(true);
  });
});

describe('ltx25_cuda runtime registration', () => {
  const info = BYOV_RUNTIME_INFO.ltx25_cuda;
  const python = resolveTestPython();

  it('registers the official cache-only CUDA pipeline in its own venv', () => {
    expect(BYOV_VIDEO_RUNTIMES.has('ltx25_cuda')).toBe(true);
    expect(info.installEnvVar).toBe('INSTALL_LTX25_CUDA');
    expect(info.repoUrl).toBe('https://github.com/Lightricks/LTX-2');
    expect(info.venvPython).not.toBe(BYOV_RUNTIME_INFO.ltx25.venvPython);
    expect(info.importProbe).toContain('DistilledPipeline');
    expect(info.importProbe).toContain('torch.cuda.is_available()');
    expect(info.currencyProbeArgs[0]).toContain('ltx25_cuda_currency.py');
    expect(info.cacheOnly).toBe(true);
    expect(info.killProcessGroup).toBe(true);
  });

  it.skipIf(!python)('requires locked transitives, source revisions and Python before hiding Repair', () => {
    const root = mkdtempSync(join(tmpdir(), 'ltx25-currency-'));
    const digest = 'a'.repeat(64);
    const url = `https://github.com/Lightricks/LTX-2/archive/${'b'.repeat(40)}.tar.gz`;
    const lock = join(root, 'runtime.lock.txt');
    const core = join(root, 'ltx_core-1.2.0.dist-info');
    const pipelines = join(root, 'ltx_pipelines-1.2.0.dist-info');
    const transitive = join(root, 'portos_transitive-2.0.dist-info');
    try {
      for (const [dir, name, version] of [[core, 'ltx-core', '1.2.0'], [pipelines, 'ltx-pipelines', '1.2.0'], [transitive, 'portos-transitive', '2.0']]) {
        mkdirSync(dir);
        writeFileSync(join(dir, 'METADATA'), `Name: ${name}\nVersion: ${version}\n`);
      }
      // uv records the verified archive URL/subdirectory, but omits archive hashes.
      const origin = (name) => JSON.stringify({ url, subdirectory: `packages/${name}`, archive_info: {} });
      writeFileSync(join(core, 'direct_url.json'), origin('ltx-core'));
      writeFileSync(join(pipelines, 'direct_url.json'), origin('ltx-pipelines'));
      writeFileSync(lock, `portos-transitive==2.0 \\\n    --hash=sha256:${digest}\n` + ['ltx-core', 'ltx-pipelines']
        .map((name) => `${name} @ ${url}#subdirectory=packages/${name} \\\n    --hash=sha256:${digest}\n`).join(''));
      const probe = (version = '3.11') => spawnSync(python, ['-c', `
import runpy, sys
sys.path.insert(0, sys.argv[3])
sys.version_info = tuple(map(int, sys.argv[4].split('.')))
sys.base_prefix = sys.argv[3]
sys.argv = [sys.argv[1], sys.argv[2]]
runpy.run_path(sys.argv[0], run_name='__main__')`, info.currencyProbeArgs[0], lock, root, version], { encoding: 'utf8', timeout: 10000 });
      expect(probe().status).toBe(0);
      writeFileSync(join(transitive, 'METADATA'), 'Name: portos-transitive\nVersion: 1.0\n');
      expect(probe().status).toBe(78);
      writeFileSync(join(transitive, 'METADATA'), 'Name: portos-transitive\nVersion: 2.0\n');
      writeFileSync(join(core, 'direct_url.json'), JSON.stringify({ url: 'https://github.com/Lightricks/LTX-2/archive/stale.tar.gz', subdirectory: 'packages/ltx-core', archive_info: {} }));
      expect(probe().status).toBe(78);
      writeFileSync(join(core, 'direct_url.json'), origin('ltx-core'));
      expect(probe('3.12').status).toBe(78);
      mkdirSync(join(root, 'conda-meta'));
      expect(probe().status).toBe(78);
    } finally { rmSync(root, { recursive: true, force: true }); }
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

  it('marks older FastVideo checkouts as upgradeable and recognizes the VSA-capable pin', async () => {
    runtimeMocks.spawn.mockImplementation(() => statusChild('old-runtime-revision\n'));
    await expect(isByovRuntimeCurrent('fastvideo')).resolves.toBe(false);
    runtimeMocks.spawn.mockImplementation(() => statusChild(`${info.expectedRevision}\n`));
    await expect(isByovRuntimeCurrent('fastvideo')).resolves.toBe(true);
  });

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

  it('identifies exactly the Apple MLX runners that need display-watchdog mitigation', () => {
    for (const runtime of ['wan22', 'ltx2', 'ltx25', 'fastvideo', 'minimax_h3']) {
      expect(runtimeUsesMlx(runtime)).toBe(true);
    }
    for (const runtime of ['wan22_cuda', 'ltx25_cuda', 'minimax_h3_cuda', 'nope', undefined]) {
      expect(runtimeUsesMlx(runtime)).toBe(false);
    }
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


describe('A2V user-LoRA stage capability', () => {
  it('keeps unsupported pins fail-closed, re-probes explicit renders and treats refusal as routine', async () => {
    runtimeMocks.spawn.mockImplementation(() => exitChild(0));
    await expect(resolveA2vLoraStageCapable('ltx25')).resolves.toBe(true);
    expect(a2vLoraStageCapable('ltx25')).toBe(true);
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      runtimeMocks.spawn.mockImplementation(() => exitChild(2, 'runtime pin is not inspected'));
      const denied = await captureProbeLogs(() => resolveA2vLoraStageCapable('ltx25', { fresh: true }));
      expect(denied).toEqual({ result: false, lines: [] });
      expect(info).toHaveBeenCalledWith(expect.stringContaining('does not support this capability'));
      expect(a2vLoraStageCapable('ltx25')).toBe(false);
      expect(runtimeMocks.spawn).toHaveBeenCalledTimes(2);
      await expect(resolveA2vLoraStageCapable('ltx25_cuda', { fresh: true })).resolves.toBe(false);
      expect(runtimeMocks.spawn).toHaveBeenCalledTimes(2);
    } finally { info.mockRestore(); }
  });
});
