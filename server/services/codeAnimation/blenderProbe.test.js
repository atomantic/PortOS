import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { probeBlenderRender } from './blenderProbe.js';

const roots = [];
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
const tool = { executable: '/example/Blender', fingerprint: 'example-runtime' };
const report = { version: '4.2.0', engine: 'CYCLES', device: 'CPU', backend: 'CPU', width: 64, height: 64, seed: 0, samples: 8, frame: 1 };
async function fixtureWorker({ metadata = report, width = 64, blank = false, corrupt = false, missing = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'portos-blender-probe-test-'));
  roots.push(directory);
  const pixels = Buffer.alloc(width * 64 * 3, 20);
  if (!blank) pixels.fill(200, pixels.length / 2);
  const png = corrupt ? Buffer.from('invalid PNG') : await sharp(pixels, { raw: { width, height: 64, channels: 3 } }).png().toBuffer();
  const json = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
  await writeFile(join(directory, 'probe.png'), png);
  await writeFile(join(directory, 'report.json'), json);
  return vi.fn(async options => {
    await options.onOutput(directory, missing ? [] : [{ path: 'report.json', bytes: Buffer.byteLength(json) }, { path: 'probe.png', bytes: png.length }]);
    return { status: 'completed', processGroupClear: true, durationMs: 12 };
  });
}

describe('Blender render readiness (synthetic worker evidence, not real Blender acceptance)', () => {
  it('requires a decoded image and exact runtime provenance, passing only fixed source through containment', async () => {
    const worker = await fixtureWorker();
    const controller = new AbortController();
    const result = await probeBlenderRender(tool, '/example/workspaces', { worker, signal: controller.signal });
    expect(result).toMatchObject({ passed: true, version: '4.2.0', render: { ...report, imageSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, durationMs: 12 });
    const options = worker.mock.calls[0][0];
    expect(options).toMatchObject({ entrypoint: 'probe.py', workspaceRoot: '/example/workspaces', signal: controller.signal });
    expect(options.tool.argv('/example/probe.py')).toEqual(['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', '/example/probe.py']);
    expect(options.files[0].content).toContain('bpy.ops.render.render(write_still=True)');
    expect(result.detail).toContain('production-sequence acceptance remain unverified');
  });

  // These uniquely guard the native-renderer/API boundary: a successful exit
  // must never turn malformed artifacts into readiness.
  it.each([
    ['missing output', { missing: true }],
    ['invalid JSON', { metadata: '{' }],
    ['unsupported version', { metadata: { ...report, version: '4.3.0' } }],
    ['wrong engine', { metadata: { ...report, engine: 'BLENDER_EEVEE_NEXT' } }],
    ['wrong device', { metadata: { ...report, device: 'GPU' } }],
    ['wrong dimensions', { width: 32 }],
    ['blank image', { blank: true }],
    ['invalid PNG', { corrupt: true }],
  ])('refuses %s despite a successful worker exit', async (_name, config) => {
    const result = await probeBlenderRender(tool, '/example/workspaces', { worker: await fixtureWorker(config) });
    expect(result).toMatchObject({ passed: false, render: null, version: null });
  });

  it.each(['failed', 'terminated'])('refuses %s workers even with a Blender version banner', async status => {
    const result = await probeBlenderRender(tool, '/example/workspaces', {
      worker: async () => ({ status, reason: 'canceled', stdout: 'Blender 4.2.0', processGroupClear: true }),
    });
    expect(result.passed).toBe(false);
  });

  it('does not spawn a missing runtime, and contains worker failures without exposing diagnostics', async () => {
    const worker = vi.fn().mockRejectedValue(new Error('private diagnostic'));
    expect(await probeBlenderRender({ executable: null }, '/example/workspaces', { worker })).toBeNull();
    expect(worker).not.toHaveBeenCalled();
    const result = await probeBlenderRender(tool, '/example/workspaces', { worker });
    expect(result.passed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
  });
});
