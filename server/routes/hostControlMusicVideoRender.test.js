import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-mv-render-') }));
afterAll(cleanupTempDataRoots);

// ffmpeg dispatch routes of the Music Video family (#12514). Real router behind
// the real host-control gate; each ffmpeg sink is a spy so an unauthorized
// caller that reaches it is visible.
const state = vi.hoisted(() => ({ enabled: false }));
const sink = vi.hoisted(() => ({
  renderMusicVideo: vi.fn(async () => ({ jobId: 'render-example' })),
  startShotRender: vi.fn(async () => ({ jobId: 'shot-example' })),
  buildRenderPreview: vi.fn(async () => ({ path: 'preview-example.mp4' })),
  coldOpenPreviewAudio: vi.fn(async () => '/tmp/cold-open-example.wav'),
  startExcerptRender: vi.fn(async () => ({ jobId: 'excerpt-example' })),
  startPublishKitBuild: vi.fn(async () => ({ jobId: 'kit-example' })),
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
vi.mock('../services/musicVideo/render.js', async (importOriginal) => ({
  ...await importOriginal(),
  renderMusicVideo: sink.renderMusicVideo,
}));
vi.mock('../services/musicVideo/shotSegments.js', async (importOriginal) => ({
  ...await importOriginal(),
  startShotRender: sink.startShotRender,
  buildRenderPreview: sink.buildRenderPreview,
}));
vi.mock('../services/musicVideo/coldOpen.js', async (importOriginal) => ({
  ...await importOriginal(),
  coldOpenPreviewAudio: sink.coldOpenPreviewAudio,
}));
vi.mock('../services/musicVideo/requireProject.js', () => ({ requireProject: vi.fn(async (id) => ({ id, scenes: [] })) }));
vi.mock('../services/musicVideo/excerptRender.js', async (importOriginal) => ({
  ...await importOriginal(),
  startExcerptRender: sink.startExcerptRender,
}));
vi.mock('../services/musicVideo/publishKit.js', async (importOriginal) => ({
  ...await importOriginal(),
  startPublishKitBuild: sink.startPublishKitBuild,
}));

import { authGate, hostControlBodyGate, hostControlRouteGate } from '../services/authGate.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import musicVideoRoutes from './musicVideo.js';

const PROJECT = '/api/music-video/example-project';
const operations = [
  [`${PROJECT}/render`, {}, sink.renderMusicVideo],
  [`${PROJECT}/shots/example-scene/render`, {}, sink.startShotRender],
  [`${PROJECT}/shot-renders/preview`, {}, sink.buildRenderPreview],
  [`${PROJECT}/cold-open/audio`, {}, sink.coldOpenPreviewAudio],
  [`${PROJECT}/excerpt`, { startSec: 0, endSec: 5 }, sink.startExcerptRender],
  [`${PROJECT}/publish-kit/build`, {}, sink.startPublishKitBuild],
];
const sinks = operations.map(([, , service]) => service);

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/music-video', musicVideoRoutes);
  app.use(errorMiddleware);
  return app;
};
const post = (app, path, body, headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = false;
});

describe('Music Video ffmpeg render dispatch host control (#12514)', () => {
  it('refuses a remote password-free caller, including spoofed-proxy variants, before any ffmpeg dispatch', async () => {
    for (const [path, body] of operations) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
      ]) {
        const response = await post(appFor(address), path, body, headers);
        expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    for (const service of sinks) expect(service).not.toHaveBeenCalled();
  });

  it('refuses a scoped peer credential or legacy Basic password even when authenticated', async () => {
    state.enabled = true;
    for (const [path, body] of operations) {
      const response = await post(appFor(), path, body, { Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') });
      expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    for (const service of sinks) expect(service).not.toHaveBeenCalled();
  });

  it('still dispatches for a local connection and for an operator session with a password set', async () => {
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: 'Bearer example-session' }],
    ]) {
      state.enabled = enabled;
      for (const [path, body, service] of operations) {
        const response = await post(appFor(address), path, body, headers);
        expect(response.status, `${path}: ${JSON.stringify(response.body)}`).not.toBe(403);
        expect(service, path).toHaveBeenCalled();
        service.mockClear();
      }
    }
  });
});
