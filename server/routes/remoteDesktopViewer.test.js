import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const broker = vi.hoisted(() => ({ hasSession: vi.fn() }));
vi.mock('../services/remoteDesktop.js', () => ({ remoteDesktopBroker: broker }));

const { default: viewerRoutes } = await import('./remoteDesktopViewer.js');

const app = express();
app.use('/remote-desktop', viewerRoutes);
app.use(errorMiddleware);

const TOKEN = 'a'.repeat(43);

beforeEach(() => { broker.hasSession.mockReset(); });

// The viewer page is served before any API auth: the broker-issued token is the
// only thing standing between a LAN caller and the VNC bridge page.
describe('GET /remote-desktop', () => {
  it('serves the viewer bound to a live session token, uncached and without a referrer', async () => {
    broker.hasSession.mockReturnValue(true);
    const res = await request(app).get(`/remote-desktop?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.text).toContain(TOKEN);
    expect(res.text).not.toContain('__REMOTE_DESKTOP_TOKEN__');
    expect(broker.hasSession).toHaveBeenCalledWith(TOKEN);
  });

  it('refuses an unknown or missing token without echoing it into a page', async () => {
    broker.hasSession.mockReturnValue(false);
    for (const path of [`/remote-desktop?token=${TOKEN}`, '/remote-desktop']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).not.toContain(TOKEN);
    }
  });

  it('rejects a repeated token parameter before consulting the broker', async () => {
    const res = await request(app).get(`/remote-desktop?token=${TOKEN}&token=${TOKEN}`);
    expect(res.status).toBe(400);
    expect(broker.hasSession).not.toHaveBeenCalled();
  });
});
