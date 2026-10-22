import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// The sharing download re-encodes the video with ffmpeg on every request and
// keeps no cached copy (#13156), so a caller without host control must not
// reach the encoder.
const auth = vi.hoisted(() => ({ enabled: false }));
const createSharingCopy = vi.hoisted(() => vi.fn());
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
  updateSettingsWith: vi.fn(async (mutate) => mutate({})),
}));
vi.mock('../services/videoGen/poster.js', () => ({ updateVideoPoster: vi.fn(), createSharingCopy }));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import videoGenRoutes from './videoGen.js';

const PATH = '/api/video-gen/history/11111111-1111-4111-8111-111111111111/sharing-download';
const appFor = (address) => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/video-gen', videoGenRoutes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('GET /api/video-gen/history/:id/sharing-download host control (#13156)', () => {
  it('refuses a remote password-free caller before the ffmpeg encode', async () => {
    const response = await request(appFor('192.0.2.10')).get(PATH);
    expect([response.status, response.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    expect(createSharingCopy).not.toHaveBeenCalled();
  });

  it('still encodes for a local caller', async () => {
    createSharingCopy.mockRejectedValue(Object.assign(new Error('Set a poster before downloading for sharing'), { status: 422 }));
    const response = await request(appFor('127.0.0.1')).get(PATH);
    expect(response.status).toBe(422);
    expect(createSharingCopy).toHaveBeenCalledTimes(1);
  });
});
