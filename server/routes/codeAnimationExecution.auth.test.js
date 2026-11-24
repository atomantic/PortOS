import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const { auth, settings, discover } = vi.hoisted(() => ({
  auth: { enabled: false, session: null },
  settings: { current: {} },
  discover: vi.fn(async () => [{ executable: '/Applications/Example.app/Contents/MacOS/Blender', version: '5.2.3' }]),
}));

vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-code-animation-execution-auth-') }));
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => settings.current),
  updateSettings: vi.fn(async (patch) => { settings.current = { ...settings.current, ...patch }; return settings.current; }),
  settingsEvents: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('../services/browserService.js', () => ({ cdpRequest: vi.fn(async () => { throw new Error('offline'); }) }));
vi.mock('../services/softwareInventory.js', () => ({ getInstalledBlenderCandidates: discover }));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => false),
  verifyRequestSession: vi.fn(async () => auth.session),
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import router from './codeAnimationExecution.js';

const gatedApp = (remoteAddress) => {
  const gated = express();
  gated.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress }); next(); });
  gated.use(authGate, hostControlRouteGate, express.json());
  gated.use('/api/code-animation/execution', router);
  gated.use(errorMiddleware);
  return gated;
};

afterAll(cleanupTempDataRoots);
beforeEach(() => {
  auth.enabled = false;
  auth.session = null;
  settings.current = {};
  discover.mockClear();
});

describe('Code Animation execution route auth gates', () => {
  it('enforces hostControlRouteGate on blender discovery when auth is disabled', async () => {
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

  it('enforces hostControlRouteGate on execution writes for remote password-free callers', async () => {
    const putRefused = await request(gatedApp('192.0.2.10'))
      .put('/api/code-animation/execution/tools')
      .send({ blender: { executable: null } });
    expect(putRefused.status).toBe(403);
    expect(putRefused.body.code).toBe('HOST_CONTROL_FORBIDDEN');

    const probeRefused = await request(gatedApp('192.0.2.10'))
      .post('/api/code-animation/execution/probe');
    expect(probeRefused.status).toBe(403);
    expect(probeRefused.body.code).toBe('HOST_CONTROL_FORBIDDEN');
  });

  it('enforces authGate when auth is enabled and admits verified operator sessions', async () => {
    auth.enabled = true;
    const path = '/api/code-animation/execution/blender-candidates';

    const unauthenticated = await request(gatedApp('127.0.0.1')).get(path);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.code).toBe('AUTH_REQUIRED');
    expect(discover).not.toHaveBeenCalled();

    auth.session = { id: 'session-1', label: 'operator' };
    const authenticated = await request(gatedApp('192.0.2.10')).get(path);
    expect(authenticated.status).toBe(200);
    expect(authenticated.body.candidates).toEqual([{ executable: '/Applications/Example.app/Contents/MacOS/Blender', version: '5.2.3' }]);
    expect(discover).toHaveBeenCalledOnce();
  });
});
