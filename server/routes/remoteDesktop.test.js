import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const broker = vi.hoisted(() => ({
  createSession: vi.fn(),
  status: vi.fn(),
}));

vi.mock('../services/remoteDesktop.js', () => ({ remoteDesktopBroker: broker }));

const { default: remoteDesktopRoutes } = await import('./remoteDesktop.js');
const { errorMiddleware } = await import('../lib/errorHandler.js');

const createApp = (authContext) => {
  const app = express();
  app.use((req, _res, next) => {
    req.portosAuthContext = authContext;
    next();
  });
  app.use('/api/remote-desktop', remoteDesktopRoutes);
  app.use(errorMiddleware);
  return app;
};

const fetchApp = async (app, path, options = {}) => {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const body = await response.json();
  await new Promise((resolve) => server.close(resolve));
  return { body, status: response.status };
};

beforeEach(() => {
  broker.createSession.mockReset();
  broker.status.mockReset();
  broker.status.mockResolvedValue({ configured: true, platform: 'darwin', port: 5900, supported: true });
  broker.createSession.mockResolvedValue({
    viewerPath: '/remote-desktop?token=fake-session-token-value-for-tests',
    expiresAt: '2030-01-01T00:00:00.000Z',
  });
});

describe('remote desktop routes', () => {
  it('reports that PortOS auth is required when the instance password is off', async () => {
    const response = await fetchApp(
      createApp({ enabled: false, authenticated: false }),
      '/api/remote-desktop/status',
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ available: false, configured: true, requiresPortOSAuth: true });
  });

  it('creates a viewer session for an authenticated instance', async () => {
    const response = await fetchApp(
      createApp({ enabled: true, authenticated: true }),
      '/api/remote-desktop/sessions',
      { method: 'POST' },
    );

    expect(response.status).toBe(201);
    expect(response.body.viewerPath).toContain('/remote-desktop?token=');
  });

  it('refuses to create a session when instance authentication is disabled', async () => {
    const response = await fetchApp(
      createApp({ enabled: false, authenticated: false }),
      '/api/remote-desktop/sessions',
      { method: 'POST' },
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('REMOTE_DESKTOP_REQUIRES_AUTH');
    expect(broker.createSession).not.toHaveBeenCalled();
  });

  it('maps a missing loopback VNC server to the documented setup error', async () => {
    broker.createSession.mockRejectedValue(Object.assign(new Error('VNC is not configured'), {
      code: 'VNC_NOT_CONFIGURED',
    }));

    const response = await fetchApp(
      createApp({ enabled: true, authenticated: true }),
      '/api/remote-desktop/sessions',
      { method: 'POST' },
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: 'VNC is not configured',
      code: 'VNC_NOT_CONFIGURED',
    });
  });
});
