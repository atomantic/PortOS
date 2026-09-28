import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { authGate, hostControlRouteGate, hostControlBodyGate } from '../services/authGate.js';
import { rmSync, readFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Real authorization middleware; only credential/settings stores are synthetic.
const auth = vi.hoisted(() => ({
  isAuthEnabled: vi.fn(),
  verifyPassword: vi.fn(async password => password === 'example-password'),
  verifyRequestSession: vi.fn(async req => req.headers.authorization === 'Bearer example-session'),
}));
vi.mock('../services/auth.js', () => auth);
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true,
    syncSecret: 'example-pair-secret-for-tests-only-123456',
  }] })),
}));

const peerHeaders = {
  [PEER_INSTANCE_HEADER]: 'example-instance',
  [PEER_AUTH_HEADER]: derivePeerAuthToken('example-pair-secret-for-tests-only-123456', 'example-instance'),
};

// Point the screenshots root at a throwaway temp dir but keep every real helper
// (saveImageUpload, sanitizeFilename, detectImageFormat, ...) so this exercises
// the actual save pipeline, not a mock of it. Created inside the hoisted factory
// to avoid a TDZ on an outer const.
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join: j } = await import('path');
  const root = mkdtempSync(j(tmpdir(), 'portos-shell-image-'));
  return { ...actual, PATHS: { ...actual.PATHS, screenshots: j(root, 'screenshots') } };
});

// The PTY registry is the one thing worth faking — a real shell session would
// spawn a process just to assert what got written to it.
vi.mock('../services/shell.js', () => ({
  getSession: vi.fn(),
  pasteToSession: vi.fn(() => true),
}));

import { PATHS } from '../lib/fileUtils.js';
import { getSession, pasteToSession } from '../services/shell.js';
import shellRoutes from './shell.js';

const buildApp = (address = '127.0.0.1') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate);
  app.use(hostControlRouteGate);
  app.use(express.json({ limit: '20mb' }));
  app.use(hostControlBodyGate);
  app.use('/api/shell', shellRoutes);
  app.use(errorMiddleware);
  return app;
};

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const pngBase64 = PNG_BYTES.toString('base64');
const SESSION = 'sess-abcdef123456';
const post = (body) => request(buildApp()).post(`/api/shell/sessions/${SESSION}/image`).send(body);

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAuthEnabled.mockResolvedValue(false);
  vi.mocked(getSession).mockReturnValue({ _id: 'sess-abc' });
  vi.mocked(pasteToSession).mockReturnValue(true);
});

afterAll(() => rmSync(dirname(PATHS.screenshots), { recursive: true, force: true }));

describe('POST /api/shell/sessions/:sessionId/image', () => {
  it('writes the bytes and pastes message + absolute path into the session', async () => {
    const res = await post({ data: pngBase64, filename: 'photo.png', message: 'what is this?' });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(SESSION);
    expect(res.body.filename).toMatch(/^shell-[0-9a-f]{8}-photo\.png$/);
    // The absolute path is never in the response — it would leak the install layout.
    expect(JSON.stringify(res.body)).not.toContain(PATHS.screenshots);

    const stored = join(PATHS.screenshots, res.body.filename);
    expect(readFileSync(stored)).toEqual(PNG_BYTES);
    expect(pasteToSession).toHaveBeenCalledWith(SESSION, `what is this?\n${stored}`, { label: 'image drop' });
  });

  it('pastes the bare path when no message is given', async () => {
    const res = await post({ data: pngBase64, filename: 'photo.png' });
    expect(res.status).toBe(200);
    expect(pasteToSession).toHaveBeenCalledWith(
      SESSION,
      join(PATHS.screenshots, res.body.filename),
      { label: 'image drop' },
    );
  });

  it('uniquifies the stored name so a repeated camera-roll name cannot overwrite', async () => {
    const before = readdirSync(PATHS.screenshots).length;
    const a = await post({ data: pngBase64, filename: 'IMG_0001.png' });
    const b = await post({ data: pngBase64, filename: 'IMG_0001.png' });
    expect(a.body.filename).not.toBe(b.body.filename);
    // Two distinct files on disk, not one overwritten twice.
    expect(readdirSync(PATHS.screenshots).length - before).toBe(2);
  });

  it('404s without writing anything when the session is gone', async () => {
    vi.mocked(getSession).mockReturnValue(null);
    const before = readdirSync(PATHS.screenshots).length;
    const res = await post({ data: pngBase64, filename: 'photo.png' });
    expect(res.status).toBe(404);
    expect(readdirSync(PATHS.screenshots)).toHaveLength(before);
    expect(pasteToSession).not.toHaveBeenCalled();
  });

  // Nothing will ever read the file, and this bucket is shared with screenshot
  // uploads — an orphan here is indistinguishable from a real one.
  it('404s and removes the written file when the session dies mid-write', async () => {
    vi.mocked(pasteToSession).mockReturnValue(false);
    const before = readdirSync(PATHS.screenshots).length;
    const res = await post({ data: pngBase64, filename: 'photo.png' });
    expect(res.status).toBe(404);
    expect(readdirSync(PATHS.screenshots).length - before).toBe(0);
  });

  it('rejects bytes that are not a supported image', async () => {
    const res = await post({ data: Buffer.from('not an image at all').toString('base64'), filename: 'photo.png' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FILE_TYPE');
    expect(pasteToSession).not.toHaveBeenCalled();
  });

  // The extension comes from the bytes, so a mislabelled upload can't land on disk
  // advertising a type it isn't.
  it('stores a PNG as .png even when the client claims .jpg', async () => {
    const res = await post({ data: pngBase64, filename: 'photo.jpg' });
    expect(res.body.filename.endsWith('.png')).toBe(true);
  });

  it('400s on a missing payload', async () => {
    const res = await post({ filename: 'photo.png' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400s on an over-long message', async () => {
    const res = await post({ data: pngBase64, filename: 'photo.png', message: 'x'.repeat(5001) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('shell image operator authority (#9030)', () => {
  const path = `/api/shell/sessions/${SESSION}/image`;
  const body = { data: pngBase64, filename: 'example.png', message: 'Describe this example.' };
  const files = () => existsSync(PATHS.screenshots) ? readdirSync(PATHS.screenshots).sort() : [];
  const call = (address, headers = {}, spelling = path) => {
    const req = request(buildApp(address)).post(spelling);
    for (const [key, value] of Object.entries(headers)) req.set(key, value);
    return req.send(body);
  };
  const expectNoEffects = before => {
    expect(files()).toEqual(before);
    expect(getSession).not.toHaveBeenCalled();
    expect(pasteToSession).not.toHaveBeenCalled();
  };

  it('refuses remote and Vite-relayed terminal input before writing an image in every route spelling', async () => {
    const before = files();
    for (const [address, headers] of [
      ['192.0.2.10', {}],
      ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
    ]) {
      for (const spelling of [path, path.toUpperCase(), path + '/']) {
        const res = await call(address, headers, spelling);
        expect(res.status, spelling).toBe(403);
        expect(res.body.code).toBe('HOST_CONTROL_FORBIDDEN');
        expectNoEffects(before);
      }
    }
  });

  it('does not grant terminal input to anonymous, valid Basic or scoped peer credentials', async () => {
    auth.isAuthEnabled.mockResolvedValue(true);
    const before = files();
    for (const [headers, status, code] of [
      [{}, 401, 'AUTH_REQUIRED'],
      [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
      [peerHeaders, 403, 'PEER_SCOPE_FORBIDDEN'],
    ]) {
      const res = await call('192.0.2.10', headers);
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
      expectNoEffects(before);
    }
  });

  it('lets an authenticated remote operator save the image and submit its message to the PTY', async () => {
    auth.isAuthEnabled.mockResolvedValue(true);
    const res = await call('192.0.2.10', { Authorization: 'Bearer example-session' });
    expect(res.status).toBe(200);
    const stored = join(PATHS.screenshots, res.body.filename);
    expect(readFileSync(stored)).toEqual(PNG_BYTES);
    expect(pasteToSession).toHaveBeenCalledWith(SESSION, `Describe this example.\n${stored}`, { label: 'image drop' });
  });
});
