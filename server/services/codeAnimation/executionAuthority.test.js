import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
const state = vi.hoisted(() => ({ settings: {}, workers: [] }));
vi.mock('../settings.js', () => ({ getSettings: async () => state.settings, updateSettings: async patch => { state.settings = { ...state.settings, ...patch }; } }));
vi.mock('../browserService.js', () => ({ cdpRequest: async () => ({ ok: false }) }));
vi.mock('./containedWorker.js', () => ({
  currentContainmentMechanism: async () => ({ supported: false, reason: 'Synthetic unavailable sandbox' }),
  runContainedWorker: vi.fn(() => { throw new Error('No contained fallback'); }),
  runTrustedLocalWorker: vi.fn(async options => {
    state.workers.push(options);
    const source = options.files[0].content;
    const reason = source.includes('Buffer.alloc(512') ? 'memory' : source.includes('setInterval') ? 'disk' : options.limits.wallSeconds === 1 ? 'time' : 'canceled';
    return { status: 'terminated', reason, processGroupClear: true };
  }),
}));
vi.mock('./blenderProbe.js', () => ({ probeBlenderRender: async (tool, _root, options) => ({ ...tool, executionMode: options.executionMode, engine: options.engine,
  passed: true, version: '4.2.0', render: { engine: options.engine, device: 'CPU', backend: 'CPU' } }) }));
import router from '../../routes/codeAnimationExecution.js';
import { resolveBlenderExecution } from './execution.js';
const app = express(); app.use(express.json()); app.use('/execution', router); app.use(errorMiddleware);
const root = await mkdtemp(join(tmpdir(), 'blender-authority-test-'));
afterAll(() => rm(root, { recursive: true, force: true }));

describe.skipIf(!['darwin', 'linux'].includes(process.platform))('machine-owned Blender execution authority', () => {
  it('defaults closed, requires acknowledgement, binds successful checks, and revokes them on save', async () => {
    const directory = join(root, 'Example.app', 'Contents', 'MacOS');
    await mkdir(directory, { recursive: true });
    const executable = join(directory, 'Blender');
    await writeFile(executable, 'synthetic runtime'); await chmod(executable, 0o755);
    const put = blender => request(app).put('/execution/tools').send({ blender });
    expect((await put({ executable })).body.executionMode).toBe('contained');
    expect((await request(app).post('/execution/probe')).body.lanes.blender.ready).toBe(false);
    expect(state.workers).toHaveLength(0);
    expect((await put({ executable, executionMode: 'trusted-local' })).status).toBe(400);
    expect(state.settings.codeAnimationExecution.blender.executionMode).toBe('contained');
    expect((await put({ executable, executionMode: 'trusted-local', acknowledgeHostAccess: true })).status).toBe(200);
    const ready = (await request(app).post('/execution/probe')).body;
    expect(ready).toMatchObject({ contained: false, executionMode: 'trusted-local', lanes: { blender: { ready: true } } });
    expect(state.workers).toHaveLength(4);
    const renderer = { kind: 'blender', version: '4.2.0', engine: 'CYCLES' };
    const bound = await resolveBlenderExecution(renderer);
    expect(bound.provenance).toMatchObject({ executionMode: 'trusted-local', contained: false });
    await expect(resolveBlenderExecution({ ...renderer, version: '4.3.0' })).rejects.toMatchObject({ code: 'CODE_ANIMATION_BLENDER_RUNTIME_MISMATCH' });
    await expect(resolveBlenderExecution(renderer, { binding: 'old-check' })).rejects.toMatchObject({ code: 'CODE_ANIMATION_BLENDER_READINESS_CHANGED' });
    await put({ executable, executionMode: 'trusted-local', acknowledgeHostAccess: true });
    await expect(resolveBlenderExecution(renderer, bound.provenance)).rejects.toMatchObject({ code: 'CODE_ANIMATION_BLENDER_NOT_READY' });
  });
});
