/** Boundary fixtures validate rejection/retention; real Blender proof is separate. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { renderBlenderSequence } from './blenderRender.js';
import { getBlenderStarterPackage } from './blenderStarter.js';

const roots = [];
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
const provenance = { binding: 'checked-runtime', version: '4.2.0', engine: 'CYCLES', device: 'CPU', backend: 'CPU', executionMode: 'trusted-local', contained: false };
async function fixture(change = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'blender-sequence-test-'));
  roots.push(directory);
  const pkg = await getBlenderStarterPackage();
  pkg.manifest.format = { width: 64, height: 64, fps: 24, durationSeconds: 1 };
  const pixels = Buffer.alloc(64 * 64 * 3, 20);
  pixels.fill(200, pixels.length / 2);
  const png = await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
  const report = { version: '4.2.0', engine: 'CYCLES', device: 'CPU', backend: 'CPU', width: 64, height: 64, fps: 24,
    frames: [1], frameCount: 24, samples: 4, seed: 17, baked: true, cameraSmooth: true,
    cadence: [{ name: 'Synthetic subject', step: 2, holdsVerified: true, motionBlur: false }], ...change.report };
  const output = { 'frame-000001.png': change.corrupt ? Buffer.from('broken') : png, 'scene.blend': Buffer.from('BLENDER-fixture'), 'report.json': Buffer.from(JSON.stringify(report)) };
  for (const [name, bytes] of Object.entries(output)) await writeFile(join(directory, name), bytes);
  const worker = vi.fn(async options => {
    if (change.canceled) { options.signal.throwIfAborted(); }
    if (!change.failed) await options.onOutput(directory, Object.entries(output).filter(([name]) => name !== change.missing).map(([path, bytes]) => ({ path, bytes: bytes.length })));
    return { status: change.failed ? 'failed' : 'completed', processGroupClear: !change.failed, durationMs: 10 };
  });
  const resolveRuntime = vi.fn(async () => ({ executable: '/example/Blender', worker, provenance }));
  const retain = vi.fn(async (_project, _run, name, bytes) => ({ relativePath: name, bytes: bytes.length, sha256: 'synthetic' }));
  const reserve = vi.fn(async () => {});
  const options = { revision: { manifest: pkg.manifest, files: pkg.files, entryPath: 'scene.py' }, runtime: provenance,
    projectId: 'synthetic-project', runId: 'synthetic-run', signal: new AbortController().signal,
    reserve, phase: 'style', captureTimes: [0], diskBytes: 1024 * 1024, wallSeconds: 30 };
  return { options, deps: { resolveRuntime, retain }, worker, reserve };
}

describe('Blender production artifact boundary', () => {
  it('binds runtime authority, decodes frames, and retains source-derived scene/evidence outside the revision', async () => {
    const { options, deps, worker, reserve } = await fixture();
    const result = await renderBlenderSequence(options, deps);
    expect(deps.resolveRuntime).toHaveBeenCalledWith(options.revision.manifest.renderer, provenance);
    expect(result).toMatchObject({ contract: { width: 64, height: 64, fps: 24, durationSec: 1 }, renderer: { executionMode: 'trusted-local', contained: false } });
    expect(result.frames[0].bytes).toBeInstanceOf(Buffer);
    expect(result.artifacts.map(file => file.name)).toEqual(['frame-000001.png', 'scene.blend', 'report.json']);
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(worker.mock.calls[0][0].files.find(file => file.path === 'scene.py').content).toBe(options.revision.files[0].content);
  });
  it('gives only the GPU engine memory headroom over the worker default', async () => {
    const cycles = await fixture();
    await renderBlenderSequence(cycles.options, cycles.deps);
    expect(cycles.worker.mock.calls[0][0].limits).not.toHaveProperty('memoryBytes');
    const eevee = await fixture({ report: { engine: 'BLENDER_EEVEE_NEXT', device: 'GPU', backend: 'METAL' } });
    const gpu = { ...provenance, engine: 'BLENDER_EEVEE_NEXT', device: 'GPU', backend: 'METAL' };
    eevee.deps.resolveRuntime.mockResolvedValue({ executable: '/example/Blender', worker: eevee.worker, provenance: gpu });
    await renderBlenderSequence({ ...eevee.options, runtime: gpu }, eevee.deps);
    expect(eevee.worker.mock.calls[0][0].limits.memoryBytes).toBe(16 * 1024 ** 3);
  });
  it.each([
    ['missing frame', { missing: 'frame-000001.png' }], ['corrupt image', { corrupt: true }],
    ['wrong runtime', { report: { version: '4.3.0' } }], ['failed worker', { failed: true }],
    ['unverified holds', { report: { cadence: [{ step: 2, holdsVerified: false, motionBlur: false }] } }],
  ])('refuses %s without accepting a sequence', async (_name, change) => {
    const { options, deps } = await fixture(change);
    await expect(renderBlenderSequence(options, deps)).rejects.toThrow();
    expect(deps.retain).not.toHaveBeenCalled();
  });
  it('retains old-bound artifacts but refuses acceptance if settings change during the worker', async () => {
    const { options, deps, worker } = await fixture();
    const runtime = await deps.resolveRuntime();
    deps.resolveRuntime.mockReset().mockResolvedValueOnce(runtime).mockRejectedValueOnce(new Error('readiness changed during render'));
    await expect(renderBlenderSequence(options, deps)).rejects.toThrow('readiness changed during render');
    expect(worker).toHaveBeenCalledTimes(1);
    expect(deps.retain).toHaveBeenCalledTimes(3);
  });
  it('refuses revoked runtime authority and pre-canceled runs before starting source', async () => {
    const { options, deps, worker } = await fixture();
    deps.resolveRuntime.mockRejectedValueOnce(new Error('readiness changed'));
    await expect(renderBlenderSequence(options, deps)).rejects.toThrow('readiness changed');
    const controller = new AbortController(); controller.abort();
    await expect(renderBlenderSequence({ ...options, signal: controller.signal }, deps)).rejects.toThrow();
    expect(worker).not.toHaveBeenCalled();
  });
});
