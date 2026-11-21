import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { authGate } from '../services/authGate.js';
import router from './shellBootstrap.js';

const reads = vi.hoisted(() => ({
  passwordRisk: vi.fn(),
  authEnabled: vi.fn(),
  settings: vi.fn(),
}));

vi.mock('../services/settings.js', () => ({ getSettings: reads.settings, settingsEvents: { on() {} } }));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: reads.authEnabled,
  verifyPassword: vi.fn(),
  verifyRequestSession: req => req.headers.authorization === 'Bearer example-session',
  getPasswordRiskStatus: reads.passwordRisk,
}));
vi.mock('../services/capabilitiesSnapshot.js', () => ({
  getShellSetupStatus: () => ({ setup: { complete: true } }),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: () => ({ peers: [] }),
  getSelf: () => ({ name: 'Example', instanceId: 'machine-private-identity' }),
}));
vi.mock('../services/instanceFeatures.js', () => ({ getInstanceFeatures: () => ({ features: [], groups: [] }) }));
vi.mock('../services/maintenanceControl.js', () => ({ readinessProjection: () => ({ state: 'normal', blockerCount: 0 }) }));
vi.mock('../services/updateChecker.js', () => ({ getShellUpdateStatus: () => ({ updateAvailable: false }) }));
vi.mock('../services/voice/config.js', () => ({
  getVoiceConfig: () => ({ enabled: true, hotkey: 'Space', stt: { engine: 'whisper', modelPath: '/private/file' } }),
}));
vi.mock('../lib/buildIdentity.js', () => ({ getBuildIdentity: () => ({ commit: 'example' }) }));

const app = express();
app.use(authGate);
app.use('/api/shell', router);
app.use(errorMiddleware);
const get = () => request(app).get('/api/shell/bootstrap');

beforeEach(() => {
  vi.clearAllMocks();
  reads.settings.mockResolvedValue({
    theme: 'classic-midnight',
    timezone: 'UTC',
    secrets: { auth: { passwordHash: 'private-placeholder' } },
  });
  reads.authEnabled.mockReturnValue(true);
  reads.passwordRisk.mockResolvedValue({ enabled: true, revision: 'protected' });
});

it('gates the private snapshot and projects only the fields needed to boot the shell', async () => {
  expect((await get()).status).toBe(401);
  expect(reads.passwordRisk).not.toHaveBeenCalled();

  const response = await get().set('Authorization', 'Bearer example-session');
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.body).toEqual({
    settings: { theme: 'classic-midnight', timezone: 'UTC' },
    selfInstance: { name: 'Example' },
    features: { features: [], groups: [] },
    voiceConfig: { enabled: true, hotkey: 'Space', stt: { engine: 'whisper' }, llm: {}, tts: {} },
    maintenance: { state: 'normal', blockerCount: 0 },
    passwordRisk: { enabled: true, revision: 'protected' },
    updateStatus: { updateAvailable: false },
    setup: { setup: { complete: true } },
    build: { commit: 'example' },
  });
});

it('preserves other shell reads when password posture is unknown', async () => {
  reads.authEnabled.mockReturnValue(false);
  reads.passwordRisk.mockRejectedValue(new Error('settings unavailable'));
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.body).not.toHaveProperty('passwordRisk');
  expect(response.body.settings).toEqual({ theme: 'classic-midnight', timezone: 'UTC' });
});
