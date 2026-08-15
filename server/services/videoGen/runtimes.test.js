import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  spawn: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => ({
  ...await importOriginal(),
  existsSync: runtimeMocks.existsSync,
}));
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal(),
  spawn: runtimeMocks.spawn,
}));

import {
  BYOV_RUNTIME_INFO, BYOV_VIDEO_RUNTIMES, MINIMAX_H3_CUDA_OFFLOAD_PROFILES,
  byovRuntimeLoraCapable, invalidateByovLoraCapabilityCache, invalidateByovReadyCache,
  isByovRuntimeReady, isPinnedSourceStatusClean, modelAnchorsLastFrame,
  resolveByovRuntimeLoraCapable, runtimeIsCacheOnly, runtimeNeedsProcessGroupKill,
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

// Exit-code-only probe child (no stdout), for the LoRA capability probe.
const exitChild = (code) => {
  const child = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit('close', code));
  return child;
};

beforeEach(() => {
  invalidateByovReadyCache();
  invalidateByovLoraCapabilityCache();
  runtimeMocks.existsSync.mockReset().mockReturnValue(true);
  runtimeMocks.spawn.mockReset();
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

// H3's DiT is quantized, so whether a LoRA can ride along is a property of the
// installed checkout, not the model entry — hence a probe rather than a
// hardcoded predicate. The gate must fail CLOSED until that probe has answered.
describe('MiniMax H3 LoRA capability', () => {
  it('reports capable when the runner exposes a quant-aware applicator', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => exitChild(0));
    await expect(resolveByovRuntimeLoraCapable('minimax_h3')).resolves.toBe(true);
    expect(byovRuntimeLoraCapable('minimax_h3')).toBe(true);
  });

  it('reports not capable when the pinned checkout has no LoRA applicator', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => exitChild(1));
    await expect(resolveByovRuntimeLoraCapable('minimax_h3')).resolves.toBe(false);
    expect(byovRuntimeLoraCapable('minimax_h3')).toBe(false);
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

  it.each(['ltx2', 'ltx25', 'wan22', 'hunyuan'])('never probes %s, which has no LoRA runtime path', async (runtime) => {
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
    ['hunyuan', false],
  ])('reports %s as %s', (runtime, anchored) => {
    expect(modelAnchorsLastFrame({ runtime })).toBe(anchored);
  });

  it('treats a missing model or runtime as not anchored', () => {
    expect(modelAnchorsLastFrame(null)).toBe(false);
    expect(modelAnchorsLastFrame({})).toBe(false);
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
    // runtime can never take LoRAs", matching wan22 / hunyuan.
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

// The JS list exists so the server can reject a bad registry `offloadProfile`
// with a stable code instead of an opaque non-zero child exit — which only
// works while it agrees with the argparse `choices=` that actually enforces it.
// Hand-synced across a language boundary is the established shape here (see
// VIDEO_PRECISIONS), so pin it rather than leave the two free to drift.
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

// Execution facts read off the registry rather than re-derived from a runtime id
// at the spawn site, so a new cache-only runtime is a table line, not an edit to
// the child-spawn path. Absent means off, as with every other optional key here.
describe('runtime execution flags', () => {
  it('reports cache-only for exactly the runners that never touch the network', () => {
    expect(runtimeIsCacheOnly('minimax_h3')).toBe(true);
    expect(runtimeIsCacheOnly('minimax_h3_cuda')).toBe(true);
    expect(runtimeIsCacheOnly('ltx2')).toBe(false);
    expect(runtimeIsCacheOnly('wan22')).toBe(false);
    expect(runtimeIsCacheOnly(undefined)).toBe(false);
  });

  it('reports group-kill for the runners that spawn children of their own', () => {
    expect(runtimeNeedsProcessGroupKill('wan22')).toBe(true);
    expect(runtimeNeedsProcessGroupKill('minimax_h3')).toBe(true);
    expect(runtimeNeedsProcessGroupKill('minimax_h3_cuda')).toBe(true);
    expect(runtimeNeedsProcessGroupKill('ltx2')).toBe(false);
    expect(runtimeNeedsProcessGroupKill('nope')).toBe(false);
  });
});
