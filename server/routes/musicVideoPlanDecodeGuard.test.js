import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// The shot, look and cleanup reads plan the render, whose performance-take
// review decodes the song master with ffmpeg. The services are spies: the
// route must hand each one `decode: true` only to a caller with host control.
const auth = vi.hoisted(() => ({ enabled: false }));
const planners = vi.hoisted(() => ({
  getShotRenderStatus: vi.fn(async () => ({ available: false })),
  listFilmLooks: vi.fn(async () => ({ available: false })),
  getRenderCleanup: vi.fn(async () => ({ finals: [], segments: {} })),
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
}));
vi.mock('../services/musicVideo/renderCleanup.js', async (importOriginal) => ({
  ...await importOriginal(),
  getRenderCleanup: planners.getRenderCleanup,
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import musicVideoRoutes from './musicVideo.js';

const PROJECT = '/api/music-video/example-project';
const reads = [
  [`${PROJECT}/shot-renders`, planners.getShotRenderStatus],
  [`${PROJECT}/film-looks`, planners.listFilmLooks],
  [`${PROJECT}/render-cleanup`, planners.getRenderCleanup],
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
});
