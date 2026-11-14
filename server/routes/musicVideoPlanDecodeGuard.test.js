import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// The shot, look and cleanup reads and their open mutations plan the render, whose performance-take
// review decodes the song master with ffmpeg. The services are spies: the
// route must hand each one `decode: true` only to a caller with host control.
const auth = vi.hoisted(() => ({ enabled: false }));
const planners = vi.hoisted(() => ({
  getShotRenderStatus: vi.fn(async () => ({ available: false })),
  listFilmLooks: vi.fn(async () => ({ available: false })),
  getRenderCleanup: vi.fn(async () => ({ finals: [], segments: {} })),
  cleanupRenders: vi.fn(async () => ({ finals: [], segments: {} })),
  deleteFilmLook: vi.fn(async () => ({ available: false })),
}));

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
  updateSettingsWith: vi.fn(async (mutate) => mutate({})),
}));
vi.mock('../services/musicVideo/shotSegments.js', async (importOriginal) => ({
  ...await importOriginal(),
  getShotRenderStatus: planners.getShotRenderStatus,
  listFilmLooks: planners.listFilmLooks,
  deleteFilmLook: planners.deleteFilmLook,
}));
vi.mock('../services/musicVideo/renderCleanup.js', async (importOriginal) => ({
  ...await importOriginal(),
  getRenderCleanup: planners.getRenderCleanup,
  cleanupRenders: planners.cleanupRenders,
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import musicVideoRoutes from './musicVideo.js';

const PROJECT = '/api/music-video/example-project';
const reads = [
  [`${PROJECT}/shot-renders`, planners.getShotRenderStatus],
  [`${PROJECT}/film-looks`, planners.listFilmLooks],
  [`${PROJECT}/render-cleanup`, planners.getRenderCleanup],
];

// Record/cache cleanup routes: they replan the render before and after the delete.
const LOOK_ID = '0123456789abcdef0123456789abcdef';
const mutations = [
  ['post', `${PROJECT}/render-cleanup`, planners.cleanupRenders, (service, options) => expect(service).toHaveBeenCalledWith('example-project', {}, options)],
  ['delete', `${PROJECT}/film-looks/${LOOK_ID}`, planners.deleteFilmLook, (service, options) => expect(service).toHaveBeenCalledWith('example-project', LOOK_ID, options)],
];

const appFor = (address) => {
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

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Music Video plan reads and the song-master decode (#13156)', () => {
  it('serves a remote password-free caller without allowing the ffmpeg decode', async () => {
    for (const [path, service] of reads) {
      const response = await request(appFor('192.0.2.10')).get(path);
      expect(response.status, path).toBe(200);
      expect(service, path).toHaveBeenCalledWith('example-project', { decode: false });
    }
  });

  it('lets a local caller decode', async () => {
    for (const [path, service] of reads) {
      expect((await request(appFor('127.0.0.1')).get(path)).status, path).toBe(200);
      expect(service, path).toHaveBeenCalledWith('example-project', { decode: true });
    }
  });

  it('refuses the cleanup and film-look delete routes to a remote password-free caller before planning', async () => {
    for (const [method, path, service] of mutations) {
      const response = await request(appFor('192.0.2.10'))[method](path).send({});
      expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      expect(service, path).not.toHaveBeenCalled();
    }
  });

  it('lets a local caller decode on the cleanup and film-look delete routes', async () => {
    for (const [method, path, service, assertCalled] of mutations) {
      const response = await request(appFor('127.0.0.1'))[method](path).send({});
      expect(response.status, path).toBe(200);
      assertCalled(service, { decode: true });
    }
  });
});
