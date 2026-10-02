import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Real gate + real mounted routers; only installer/spawn effects are doubled (#9555).
const state = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: vi.fn(async () => state.enabled),
  verifyRequestSession: vi.fn(async req => req.headers.authorization === 'Bearer example-session'),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../lib/setupScriptRunner.js', async (importOriginal) => ({
  ...await importOriginal(),
  stopSetupScript: vi.fn(),
  spawnSetupScript: vi.fn(),
}));
vi.mock('../services/ytdlpUpdate.js', () => ({
  getYtDlpUpdateStatus: vi.fn(async () => ({ version: '1.0.0' })),
  updateYtDlp: vi.fn(async () => ({ success: true, version: '1.0.1' })),
}));
vi.mock('../services/videoDownload.js', () => ({}));
vi.mock('../services/imageTo3d/targets.js', () => ({
  getTarget: vi.fn(() => ({ id: 'trellis2' })),
  listTargets: vi.fn(() => []),
  detectHostCapabilities: vi.fn(() => ({})),
  unavailableReason: vi.fn(() => null),
  unavailableReasonLabel: vi.fn(() => ''),
  IMAGE_TO_3D_TARGET_IDS: ['trellis2', 'pixal3d', 'pixal3d-cuda'],
  renderOptionSupportFor: vi.fn(() => ({})),
}));
vi.mock('../services/imageTo3d/adapters.js', () => ({
  getTargetAdapter: vi.fn(() => ({ install: vi.fn(), getInstallStatus: vi.fn(async () => ({})) })),
}));
vi.mock('../services/imageTo3d/models.js', () => ({ USDZ_MAX_BYTES: 1 }));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { isHostControlRoute } from '../lib/hostControlRoutes.js';
import imageTo3dRoutes from './imageTo3d.js';
import midiRuntimeRoutes from './midiRuntime.js';
import videoDownloadRoutes from './videoDownload.js';
import { spawnSetupScript } from '../lib/setupScriptRunner.js';
import { updateYtDlp } from '../services/ytdlpUpdate.js';
import { getTargetAdapter } from '../services/imageTo3d/adapters.js';

const installers = [
  '/api/image-to-3d/targets/trellis2/install',
  '/api/image-to-3d/targets/pixal3d/install',
  '/api/image-to-3d/targets/pixal3d-cuda/install',
  '/api/image-to-3d/trellis2/install',
  '/api/midi-runtime/install',
  '/api/devtools/video-download/yt-dlp/update',
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/image-to-3d', imageTo3dRoutes);
  app.use('/api/midi-runtime', midiRuntimeRoutes);
  app.use('/api/devtools/video-download', videoDownloadRoutes);
  app.use(errorMiddleware);
  return app;
};
const post = (app, path, headers = {}) => {
  const pending = request(app).post(path);
  for (const [k, v] of Object.entries(headers)) pending.set(k, v);
  return pending.send({});
};
const expectNoEffects = () => {
  expect(spawnSetupScript).not.toHaveBeenCalled();
  expect(updateYtDlp).not.toHaveBeenCalled();
  expect(getTargetAdapter).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = false;
});

describe('runtime installer operator authority (#9555)', () => {
  it('lists every installer as a host-control route', () => {
    for (const path of installers) expect(isHostControlRoute('POST', path), path).toBe(true);
    expect(isHostControlRoute('GET', '/api/midi-runtime/install')).toBe(false);
  });

  it('refuses remote password-free callers before any installer runs', async () => {
    for (const path of installers) {
      const res = await post(appFor(), path);
      expect([res.status, res.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
    }
    expectNoEffects();
  });

  it('rejects anonymous (401) and legacy Basic (403) callers on a password-enabled install', async () => {
    state.enabled = true;
    const basic = { Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') };
    for (const path of installers) {
      const anon = await post(appFor(), path);
      expect([anon.status, anon.body.code], path).toEqual([401, 'AUTH_REQUIRED']);
      const legacy = await post(appFor(), path, basic);
      expect([legacy.status, legacy.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('lets local and operator callers through the gate; status GETs stay open', async () => {
    const local = await post(appFor('127.0.0.1'), '/api/devtools/video-download/yt-dlp/update');
    expect(local.status).toBe(200);
    state.enabled = true;
    const operator = await post(appFor(), '/api/devtools/video-download/yt-dlp/update', { Authorization: 'Bearer example-session' });
    expect(operator.status).toBe(200);
    expect(updateYtDlp).toHaveBeenCalledTimes(2);

    state.enabled = false;
    const status = await request(appFor()).get('/api/devtools/video-download/yt-dlp');
    expect(status.status).toBe(200);
  });
});
