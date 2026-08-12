import { EventEmitter } from 'node:events';
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
  byovRuntimeLoraCapable, invalidateByovLoraCapabilityCache, invalidateByovReadyCache,
  isByovRuntimeReady, isPinnedSourceStatusClean, modelAnchorsLastFrame,
  resolveByovRuntimeLoraCapable,
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

  it.each(['ltx2', 'wan22', 'hunyuan'])('never probes %s, which has no LoRA runtime path', async (runtime) => {
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
    ['minimax_h3', true],
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
