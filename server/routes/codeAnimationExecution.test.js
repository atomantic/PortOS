import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { currentContainmentMechanism } from '../services/codeAnimation/containedWorker.js';

const { settings, discover } = vi.hoisted(() => ({
  settings: { current: {} },
  discover: vi.fn(async () => [{ executable: '/Applications/Example.app/Contents/MacOS/Blender', version: '5.2.3' }]),
}));
vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-code-animation-execution-') }));
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => settings.current),
  updateSettings: vi.fn(async (patch) => { settings.current = { ...settings.current, ...patch }; return settings.current; }),
  settingsEvents: { on: vi.fn(), off: vi.fn() },
}));
// The browser lane's availability is reported, not exercised, by the probe.
vi.mock('../services/browserService.js', () => ({ cdpRequest: vi.fn(async () => { throw new Error('offline'); }) }));
vi.mock('../services/softwareInventory.js', () => ({ getInstalledBlenderCandidates: discover }));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: vi.fn().mockResolvedValue(false), verifyPassword: vi.fn(), verifyRequestSession: vi.fn(),
}));

import { PATHS } from '../lib/paths.js';
import { authGate, hostControlRouteGate } from '../services/authGate.js';
import router from './codeAnimationExecution.js';

const app = express();
app.use(express.json());
app.use('/api/code-animation/execution', router);
app.use(errorMiddleware);
const gatedApp = (remoteAddress) => {
  const gated = express();
  gated.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress }); next(); });
  gated.use(authGate, hostControlRouteGate, express.json());
  gated.use('/api/code-animation/execution', router);
  gated.use(errorMiddleware);
  return gated;
};
const mechanism = await currentContainmentMechanism();
const supported = mechanism.supported;
if (process.env.PORTOS_REQUIRE_LINUX_CONTAINMENT === '1' && mechanism.id !== 'linux-bubblewrap') {
  throw new Error(`Real Linux containment is required by this test job: ${mechanism.reason}`);
}
const scratch = [];
afterAll(async () => {
  cleanupTempDataRoots();
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});
beforeEach(() => { settings.current = {}; discover.mockClear(); });

const executableAt = async (dir, name = 'blender') => {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, '#!/bin/sh\necho "Blender 4.2.0"\n');
  await chmod(path, 0o755);
  return path;
};

describe('Code Animation execution capability', () => {
  it('limits installed Blender discovery to an operator', async () => {
    const path = '/api/code-animation/execution/blender-candidates';
    const refused = await request(gatedApp('192.0.2.10')).get(path);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    expect(discover).not.toHaveBeenCalled();
    const allowed = await request(gatedApp('127.0.0.1')).get(path);
    expect(allowed.status).toBe(200);
    expect(allowed.body.candidates).toEqual([{ executable: '/Applications/Example.app/Contents/MacOS/Blender', version: '5.2.3' }]);
    expect(discover).toHaveBeenCalledOnce();
  });

  it('stays fail-closed before a containment check has passed on this server process', async () => {
    const { status, body } = await request(app).get('/api/code-animation/execution');
    expect(status).toBe(200);
    expect(body.probe).toBeNull();
    expect(body.lanes.blender.ready).toBe(false);
    expect(body.lanes.browser.mechanism).toBe('chromium-cdp-sandbox');
    expect(body.mechanism.supported).toBe(supported);
    if (!supported) expect(body.mechanism.reason).toMatch(/refused|unavailable/);
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
    expect(settings.current.codeAnimationExecution).toEqual({ blender: { executable: await realpath(tool), executionMode: 'contained', engine: 'CYCLES' } });
    expect(body.tools.blender).toMatchObject({ executable: await realpath(tool), problem: null });
    expect(body.lanes.blender.ready).toBe(false);

    await put(null);
    expect(settings.current.codeAnimationExecution).toEqual({ blender: { executable: null, executionMode: 'contained', engine: 'CYCLES' } });
  });

  it.skipIf(supported)('refuses the containment check where no enforced mechanism exists', async () => {
    const { body } = await request(app).post('/api/code-animation/execution/probe');
    expect(body.probe).toMatchObject({ passed: false, mechanism: null, checks: [] });
    expect(body.probe.refused).toMatch(/refused|unavailable/);
    expect(body.lanes.blender.ready).toBe(false);
  });

  // Actual mechanism evidence: synthetic hostile packages run through the real
  // Seatbelt worker, and each boundary/limit is observed failing for them.
  it.skipIf(!supported)('proves the host containment boundary and limits, and keeps a tool that cannot start contained refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portos-tool-'));
    scratch.push(dir);
    // A script tool needs /bin/sh, which the worker profile does not grant.
    settings.current = { codeAnimationExecution: { blender: { executable: await executableAt(join(dir, 'Blender.app', 'Contents', 'MacOS')) } } };

    const { status, body } = await request(app).post('/api/code-animation/execution/probe');
    expect(status).toBe(200);
    expect(body.probe.mechanism).toBe(mechanism.id);
    expect(Object.fromEntries(body.probe.checks.map((check) => [check.id, check.passed]))).toEqual({
      'worker-runs': true, 'read-outside': true, 'list-data': true, 'list-home': true, 'write-outside': true,
      'write-input': true, 'spawn-process': true, 'file-size': true, credentials: true, 'host-api': true, network: true,
      'limit-time': true, 'limit-disk': true, 'limit-memory': true, 'limit-cancel': true,
    });
    expect(body.probe.passed).toBe(true);
    expect(body.probe.tools.blender).toMatchObject({ passed: false, version: null });
    expect(body.lanes.blender).toEqual({ ready: false, reason: expect.stringMatching(/^Blender did not render the supported test scene in contained mode\. Blender (exited with code \d+|crashed with SIG\w+)\.$/) });
    // Every owned workspace was removed, including the terminated ones.
    expect(await readdir(join(PATHS.data, 'code-animation-workspaces'))).toEqual([]);
  }, 60_000);
});
