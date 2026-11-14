import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-mv-blender-host-') }));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-mv-blender-host-') }));
afterAll(cleanupTempDataRoots);

// A Blender film is operator Python that runs with host access. Real router
// behind the real host-control gate; every route that writes the source Blender
// will run, runs Blender or ffmpeg, opens the Blender application or deletes
// rendered frames is a spy, so an unauthorized caller that reaches one is visible.
const state = vi.hoisted(() => ({ enabled: false }));
const sink = vi.hoisted(() => ({
  scaffoldBlenderWorkspace: vi.fn(async () => ({ copied: [] })),
  writeBlenderFile: vi.fn(async () => ({ path: 'film.py', bytes: 1 })),
  deleteBlenderFile: vi.fn(async () => ({ path: 'film.py' })),
  startBlenderSync: vi.fn(async () => ({ job: { id: 'bj-example-sync' } })),
  clearBlenderFrames: vi.fn(async () => ({ freedBytes: 0 })),
  enqueueBlenderRenders: vi.fn(async () => ({ jobs: [], skipped: [] })),
  startBlenderCut: vi.fn(async () => ({ job: { id: 'bj-example' } })),
  openBlenderShot: vi.fn(async () => ({ opened: true })),
}));
const open = vi.hoisted(() => ({
  saveBlenderSettings: vi.fn(async () => ({})),
  saveBlenderShotNote: vi.fn(async () => ({})),
  cancelBlenderProjectJobs: vi.fn(() => true),
}));

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => state.enabled),
  verifyRequestSession: vi.fn(async (req) => req.headers.authorization === 'Bearer example-session'),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
  updateSettingsWith: vi.fn(async (mutate) => mutate({})),
}));
vi.mock('../services/musicVideo/requireProject.js', () => ({ requireProject: vi.fn(async (id) => ({ id, scenes: [] })) }));
vi.mock('../services/musicVideo/blender/state.js', async (importOriginal) => ({ ...await importOriginal(), getBlenderState: vi.fn(async () => ({ settings: {} })) }));
vi.mock('../services/film/song.js', async (importOriginal) => ({ ...await importOriginal(), writeBlenderSong: vi.fn(async () => ({})) }));
vi.mock('../services/film/sources.js', async (importOriginal) => ({
  ...await importOriginal(),
  scaffoldBlenderWorkspace: sink.scaffoldBlenderWorkspace, writeBlenderFile: sink.writeBlenderFile, deleteBlenderFile: sink.deleteBlenderFile,
}));
vi.mock('../services/film/sync.js', async (importOriginal) => ({ ...await importOriginal(), startBlenderSync: sink.startBlenderSync }));
vi.mock('../services/film/usage.js', async (importOriginal) => ({ ...await importOriginal(), clearBlenderFrames: sink.clearBlenderFrames }));
vi.mock('../services/film/queue.js', async (importOriginal) => ({
  ...await importOriginal(), enqueueBlenderRenders: sink.enqueueBlenderRenders, cancelBlenderProjectJobs: open.cancelBlenderProjectJobs,
}));
vi.mock('../services/musicVideo/blender/cuts.js', async (importOriginal) => ({ ...await importOriginal(), startBlenderCut: sink.startBlenderCut }));
vi.mock('../services/film/open.js', async (importOriginal) => ({ ...await importOriginal(), openBlenderShot: sink.openBlenderShot }));
vi.mock('../services/film/record.js', async (importOriginal) => ({
  ...await importOriginal(), saveBlenderSettings: open.saveBlenderSettings, saveBlenderShotNote: open.saveBlenderShotNote,
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import musicVideoRoutes from './musicVideo.js';

const FILM = '/api/music-video/example-project/blender';
const operations = [
  ['post', `${FILM}/workspace`, { template: 'starter' }, sink.scaffoldBlenderWorkspace],
  ['put', `${FILM}/file`, { path: 'film.py', content: 'print("example")\n' }, sink.writeBlenderFile],
  ['delete', `${FILM}/file?path=film.py`, undefined, sink.deleteBlenderFile],
  ['post', `${FILM}/sync`, {}, sink.startBlenderSync],
  ['post', `${FILM}/frames/clear`, {}, sink.clearBlenderFrames],
  ['post', `${FILM}/render`, { quality: 'preview' }, sink.enqueueBlenderRenders],
  ['post', `${FILM}/cut`, { quality: 'preview' }, sink.startBlenderCut],
  ['post', `${FILM}/shots/s010/open`, {}, sink.openBlenderShot],
];
// Records and cancellation: nothing here chooses or starts what runs.
const recordOperations = [
  ['put', `${FILM}/settings`, { fps: 30 }, open.saveBlenderSettings],
  ['put', `${FILM}/shots/s010/note`, { text: 'Example note' }, open.saveBlenderShotNote],
  ['post', `${FILM}/cancel`, {}, open.cancelBlenderProjectJobs],
];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/music-video', musicVideoRoutes);
  app.use(errorMiddleware);
  return app;
};
const send = (app, method, path, body, headers = {}) => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return body === undefined ? pending : pending.send(body);
};

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = false;
});

describe('Music Video Blender film host control', () => {
  it('refuses a remote password-free caller, including spoofed-proxy variants, before any source write or process', async () => {
    for (const [method, path, body] of operations) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
      ]) {
        const response = await send(appFor(address), method, path, body, headers);
        expect([response.status, response.body.code], `${method} ${path}`).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    for (const [, , , service] of operations) expect(service).not.toHaveBeenCalled();
  });

  it('refuses a scoped peer credential or legacy Basic password even when authenticated', async () => {
    state.enabled = true;
    for (const [method, path, body] of operations) {
      const response = await send(appFor(), method, path, body, { Authorization: `Basic ${Buffer.from(':example-password').toString('base64')}` });
      expect([response.status, response.body.code], `${method} ${path}`).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    for (const [, , , service] of operations) expect(service).not.toHaveBeenCalled();
  });

  it('still runs for a local connection and for an operator session with a password set', async () => {
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: 'Bearer example-session' }],
    ]) {
      state.enabled = enabled;
      for (const [method, path, body, service] of operations) {
        const response = await send(appFor(address), method, path, body, headers);
        expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBeLessThan(300);
        expect(service, `${method} ${path}`).toHaveBeenCalledTimes(1);
        service.mockClear();
      }
    }
  });

  it('refuses remote settings, notes and cancellation, and saves them for a local caller without running anything', async () => {
    for (const [method, path, body, service] of recordOperations) {
      const refused = await send(appFor(), method, path, body);
      expect([refused.status, refused.body.code], `${method} ${path}`).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      expect(service, `${method} ${path}`).not.toHaveBeenCalled();
    }
    for (const [method, path, body, service] of recordOperations) {
      const response = await send(appFor('127.0.0.1'), method, path, body);
      expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(200);
      expect(service, `${method} ${path}`).toHaveBeenCalledTimes(1);
    }
    for (const [, , , service] of operations) expect(service).not.toHaveBeenCalled();
  });
});
