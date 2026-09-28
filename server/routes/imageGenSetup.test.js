/**
 * #9015 — `/api/image-gen/setup/*` must not execute any caller-supplied file
 * merely because it is NAMED `python*`. Before this fix, `isAllowedPython`
 * was a basename-only check: `pythonPath=/tmp/x/python3` (or a UNC share on
 * Windows) passed it and was executed straight away. These tests exercise
 * `resolveSetupInterpreter`'s AUTHORITY gate through the REAL `authGate`
 * middleware (mirroring `server/routes/hostControlFamilies.test.js`), so the
 * loopback-vs-remote distinction is the genuine one `requestHasHostControl`
 * makes, not a stand-in.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-imagegen-setup-') }));
afterAll(cleanupTempDataRoots);

// Pinned to a password-free install, same as hostControlFamilies.test.js —
// the developer's own settings must not change what these cases observe.
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAuthEnabled: vi.fn().mockResolvedValue(false),
}));

const settingsStore = vi.hoisted(() => ({ current: {} }));
vi.mock('../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(async () => settingsStore.current),
  updateSettingsWith: vi.fn(async (mutate) => mutate(settingsStore.current)),
}));

const setupCheck = vi.hoisted(() => ({
  getSetupCheck: vi.fn(async (pythonPath) => ({ pythonPath, installed: [], missing: [] })),
  invalidateSetupCheck: vi.fn(),
}));
vi.mock('../services/imageGen/setup.js', () => ({
  getSetupCheck: setupCheck.getSetupCheck,
  invalidateSetupCheck: setupCheck.invalidateSetupCheck,
  REQUIRED_PIP_NAMES: new Set(['mflux']),
}));

const pySetup = vi.hoisted(() => ({
  createVenv: vi.fn(async (_base, target) => join(target, 'bin', 'python3')),
  installPackages: vi.fn(() => ({ promise: Promise.resolve(), kill: vi.fn() })),
}));
vi.mock('../lib/pythonSetup.js', async (importOriginal) => ({
  ...(await importOriginal()), // keep the real isAllowedPython format check
  detectPython: vi.fn(async () => 'python3'),
  createVenv: pySetup.createVenv,
  installPackages: pySetup.installPackages,
  resolveFlux2Python: vi.fn(() => null),
  isFlux2InstallSatisfied: vi.fn(async () => true),
}));

import { authGate } from '../services/authGate.js';
import imageGenSetupRoutes from './imageGenSetup.js';
import { PATHS } from '../lib/fileUtils.js';

// Mirrors the order server/index.js mounts them in: authGate observes the
// real socket address, same as hostControlFamilies.test.js.
const buildApp = (remoteAddress) => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress });
    next();
  });
  app.use(authGate);
  app.use(express.json());
  app.use('/api/image-gen/setup', imageGenSetupRoutes);
  app.use(errorMiddleware);
  return app;
};

const remote = () => buildApp('192.0.2.10');
const local = () => buildApp('127.0.0.1');

const expectForbidden = (response) => {
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
};

describe('/api/image-gen/setup/* interpreter admission (#9015)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsStore.current = {};
    setupCheck.getSetupCheck.mockClear();
    pySetup.createVenv.mockClear();
    pySetup.installPackages.mockClear();
  });

  it('refuses a remote password-free caller naming an arbitrary absolute interpreter, and spawns nothing', async () => {
    const arbitrary = '/tmp/x/python3';

    expectForbidden(await request(remote()).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(arbitrary)}`));
    expect(setupCheck.getSetupCheck).not.toHaveBeenCalled();

    expectForbidden(await request(remote()).post('/api/image-gen/setup/create-venv').send({ basePython: arbitrary }));
    expect(pySetup.createVenv).not.toHaveBeenCalled();

    expectForbidden(await request(remote())
      .post(`/api/image-gen/setup/install?pythonPath=${encodeURIComponent(arbitrary)}&packages=mflux`));
    expect(pySetup.installPackages).not.toHaveBeenCalled();
  });

  it('a UNC path is rejected as an invalid interpreter (400) before authority is even considered', async () => {
    const unc = '\\\\host\\share\\python.exe';
    const response = await request(remote()).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(unc)}`);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_PYTHON_PATH');
    expect(setupCheck.getSetupCheck).not.toHaveBeenCalled();
  });

  it('a remote caller may still use a bare basename — execFile resolves it on the server PATH', async () => {
    const response = await request(remote()).get('/api/image-gen/setup/check?pythonPath=python3');
    expect(response.status).toBe(200);
    expect(setupCheck.getSetupCheck).toHaveBeenCalledWith('python3');
  });

  it('a remote caller may still use the interpreter stored in settings.imageGen.local.pythonPath', async () => {
    const stored = '/opt/example-venv/bin/python3';
    settingsStore.current = { imageGen: { local: { pythonPath: stored } } };
    const response = await request(remote()).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(stored)}`);
    expect(response.status).toBe(200);
    expect(setupCheck.getSetupCheck).toHaveBeenCalledWith(stored);
  });

  it('a remote caller may still reach an interpreter inside the PortOS-managed venv directory', async () => {
    const venvDir = join(PATHS.data, 'python', 'venv', 'bin');
    mkdirSync(venvDir, { recursive: true });
    const managedPython = join(venvDir, 'python3');
    writeFileSync(managedPython, '');

    const response = await request(remote()).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(managedPython)}`);
    expect(response.status).toBe(200);
    expect(setupCheck.getSetupCheck).toHaveBeenCalledWith(managedPython);
  });

  it('a loopback caller on a password-free install may still probe or install into any interpreter path', async () => {
    const arbitrary = '/tmp/x/python3';

    const check = await request(local()).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(arbitrary)}`);
    expect(check.status).toBe(200);
    expect(setupCheck.getSetupCheck).toHaveBeenCalledWith(arbitrary);

    const venv = await request(local()).post('/api/image-gen/setup/create-venv').send({ basePython: arbitrary });
    expect(venv.status).toBe(200);
    expect(pySetup.createVenv).toHaveBeenCalledWith(arbitrary, expect.any(String));

    const install = await request(local())
      .post(`/api/image-gen/setup/install?pythonPath=${encodeURIComponent(arbitrary)}&packages=mflux`);
    expect(install.status).toBe(200);
    expect(pySetup.installPackages).toHaveBeenCalled();
  });
});
