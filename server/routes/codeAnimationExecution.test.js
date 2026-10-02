import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { CODE_ANIMATION_SEATBELT } from '../lib/codeAnimationContainment.js';

const { settings } = vi.hoisted(() => ({ settings: { current: {} } }));
vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-code-animation-execution-') }));
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => settings.current),
  updateSettings: vi.fn(async (patch) => { settings.current = { ...settings.current, ...patch }; return settings.current; }),
}));
// The browser lane's availability is reported, not exercised, by the probe.
vi.mock('../services/browserService.js', () => ({ cdpRequest: vi.fn(async () => { throw new Error('offline'); }) }));

import { PATHS } from '../lib/paths.js';
import router from './codeAnimationExecution.js';

const app = express();
app.use(express.json());
app.use('/api/code-animation/execution', router);
app.use(errorMiddleware);
const seatbelt = process.platform === 'darwin' && existsSync(CODE_ANIMATION_SEATBELT);
const scratch = [];
afterAll(async () => {
  cleanupTempDataRoots();
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});
beforeEach(() => { settings.current = {}; });

const executableAt = async (dir, name = 'blender') => {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, '#!/bin/sh\necho "Blender 4.2.0"\n');
  await chmod(path, 0o755);
  return path;
};

describe('Code Animation execution capability', () => {
  it('stays fail-closed before a containment check has passed on this server process', async () => {
    const { status, body } = await request(app).get('/api/code-animation/execution');
    expect(status).toBe(200);
    expect(body.probe).toBeNull();
    expect(body.lanes.blender.ready).toBe(false);
    expect(body.lanes.browser.mechanism).toBe('chromium-cdp-sandbox');
    expect(body.mechanism.supported).toBe(seatbelt);
    if (!seatbelt) expect(body.mechanism.reason).toMatch(/refused|unavailable/);
  });

  it('accepts only an operator tool that cannot expose PortOS data, and stores its realpath', async () => {
    const put = (executable) => request(app).put('/api/code-animation/execution/tools').send({ blender: { executable } });
    expect((await put('blender')).status).toBe(400);
    expect((await put(join(tmpdir(), 'portos-no-such-blender'))).body.code).toBe('CODE_ANIMATION_TOOL_INVALID');
    const planted = await executableAt(join(PATHS.data, 'code-animations', 'projects', 'evil'));
    expect((await put(planted)).body.code).toBe('CODE_ANIMATION_TOOL_INVALID');
    expect(settings.current.codeAnimationExecution).toBeUndefined();

    const dir = await mkdtemp(join(tmpdir(), 'portos-tool-'));
    scratch.push(dir);
    const tool = await executableAt(join(dir, 'Blender.app', 'Contents', 'MacOS'));
    const { status, body } = await put(tool);
    expect(status).toBe(200);
    expect(settings.current.codeAnimationExecution).toEqual({ blender: { executable: await realpath(tool) } });
    expect(body.tools.blender).toMatchObject({ executable: await realpath(tool), problem: null });
    expect(body.lanes.blender.ready).toBe(false);

    await put(null);
    expect(settings.current.codeAnimationExecution).toEqual({ blender: { executable: null } });
  });

  it.skipIf(seatbelt)('refuses the containment check where no enforced mechanism exists', async () => {
    const { body } = await request(app).post('/api/code-animation/execution/probe');
    expect(body.probe).toMatchObject({ passed: false, mechanism: null, checks: [] });
    expect(body.probe.refused).toMatch(/refused|unavailable/);
    expect(body.lanes.blender.ready).toBe(false);
  });

  // Actual mechanism evidence: synthetic hostile packages run through the real
  // Seatbelt worker, and each boundary/limit is observed failing for them.
  it.skipIf(!seatbelt)('proves the macOS Seatbelt boundary and limits, and keeps a tool that cannot start contained refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portos-tool-'));
    scratch.push(dir);
    // A script tool needs /bin/sh, which the worker profile does not grant.
    settings.current = { codeAnimationExecution: { blender: { executable: await executableAt(join(dir, 'Blender.app', 'Contents', 'MacOS')) } } };

    const { status, body } = await request(app).post('/api/code-animation/execution/probe');
    expect(status).toBe(200);
    expect(body.probe.mechanism).toBe('macos-seatbelt');
    expect(Object.fromEntries(body.probe.checks.map((check) => [check.id, check.passed]))).toEqual({
      'worker-runs': true, 'read-outside': true, 'list-data': true, 'list-home': true, 'write-outside': true,
      'write-input': true, 'spawn-process': true, 'file-size': true, credentials: true, 'host-api': true, network: true,
      'limit-time': true, 'limit-disk': true, 'limit-memory': true, 'limit-cancel': true,
    });
    expect(body.probe.passed).toBe(true);
    expect(body.probe.tools.blender).toMatchObject({ passed: false, version: null });
    expect(body.lanes.blender).toEqual({ ready: false, reason: 'Blender did not render the supported test scene under containment.' });
    // Every owned workspace was removed, including the terminated ones.
    expect(await readdir(join(PATHS.data, 'code-animation-workspaces'))).toEqual([]);
  }, 60_000);
});
