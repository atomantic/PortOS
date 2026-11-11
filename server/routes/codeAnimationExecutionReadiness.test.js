import { afterAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const state = vi.hoisted(() => ({ settings: {}, renderCalls: 0 }));
vi.mock('../lib/paths.js', async importOriginal =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-blender-readiness-') }));
vi.mock('../services/settings.js', () => ({
  getSettings: async () => state.settings,
  updateSettings: async patch => { state.settings = { ...state.settings, ...patch }; },
}));
vi.mock('../services/browserService.js', () => ({ cdpRequest: async () => ({ ok: false }) }));
vi.mock('../services/codeAnimation/containedWorker.js', () => ({
  currentContainmentMechanism: async () => ({ supported: false, reason: 'Synthetic unavailable sandbox' }),
  runContainedWorker: vi.fn(() => { throw new Error('Unexpected contained worker'); }),
  runTrustedLocalWorker: vi.fn(async options => {
    if (options.entrypoint === 'probe.py') {
      state.renderCalls += 1;
      return { status: 'failed', reason: 'exit', exitCode: 1, processGroupClear: true, stderr: 'private worker output' };
    }
    const source = options.files[0].content;
    const reason = source.includes('Buffer.alloc(512') ? 'memory' : source.includes('setInterval') ? 'disk' : options.limits.wallSeconds === 1 ? 'time' : 'canceled';
    return { status: 'terminated', reason, processGroupClear: true };
  }),
}));

import router from './codeAnimationExecution.js';

const app = express();
app.use(express.json());
app.use('/execution', router);
app.use(errorMiddleware);
const roots = [];
afterAll(async () => {
  cleanupTempDataRoots();
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!['darwin', 'linux'].includes(process.platform))('Blender execution check result', () => {
  it('distinguishes successful supervision from an absent or failed Blender test render', async () => {
    // As an older release stored and sent it: the retired acknowledgement is still read and accepted.
    const settings = { executable: null, executionMode: 'trusted-local', engine: 'BLENDER_EEVEE_NEXT', acknowledgeHostAccess: true };
    state.settings = { codeAnimationExecution: { blender: settings } };
    const missing = await request(app).post('/execution/probe');
    expect(missing.status).toBe(200);
    expect(missing.body.probe).toMatchObject({ passed: true, contained: false, checks: expect.arrayContaining([
      expect.objectContaining({ id: 'limit-time', passed: true }),
      expect.objectContaining({ id: 'limit-disk', passed: true }),
      expect.objectContaining({ id: 'limit-memory', passed: true }),
      expect.objectContaining({ id: 'limit-cancel', passed: true }),
    ]), tools: {} });
    expect(missing.body.lanes.blender).toEqual({ ready: false, reason: 'Blender: Not configured.' });
    expect(state.renderCalls).toBe(0);

    const root = await mkdtemp(join(tmpdir(), 'portos-synthetic-blender-'));
    roots.push(root);
    const directory = join(root, 'Example.app', 'Contents', 'MacOS');
    await mkdir(directory, { recursive: true });
    const executable = join(directory, 'Blender');
    await writeFile(executable, 'synthetic runtime');
    await chmod(executable, 0o755);
    expect((await request(app).put('/execution/tools').send({ blender: { ...settings, executable } })).status).toBe(200);

    const failed = await request(app).post('/execution/probe');
    expect(failed.status).toBe(200);
    expect(failed.body.probe).toMatchObject({ passed: true, tools: { blender: { passed: false, detail: expect.stringContaining('Blender render check failed') } } });
    expect(failed.body.lanes.blender).toEqual({ ready: false, reason: 'Blender did not render the supported test scene in trusted-local mode. Blender exited with code 1.' });
    expect(state.renderCalls).toBe(1);
    // Only a check whose test render passed may be re-run unasked after a restart.
    expect(state.settings.codeAnimationExecutionArmed).toBeNull();
    expect(JSON.stringify(failed.body)).not.toContain('private worker output');
  });
});
