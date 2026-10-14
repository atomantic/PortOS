import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-capture-authority-') }));
afterAll(cleanupTempDataRoots);
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({ loadData: vi.fn(async () => ({ peers: [] })) }));
vi.mock('../services/mediaService.js', () => ({ default: {
  listDevices: vi.fn(async () => []),
  isVideoStreaming: vi.fn(() => true), isAudioStreaming: vi.fn(() => true),
  startVideoStream: vi.fn(), startAudioStream: vi.fn(), stopAll: vi.fn(),
  getVideoStream: vi.fn(), getAudioStream: vi.fn(),
} }));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import mediaService from '../services/mediaService.js';
import mediaRoutes from './media.js';

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/media', mediaRoutes);
  app.use(errorMiddleware);
  return app;
};
const operations = [
  ['post', '/api/media/start'],
  ['get', '/api/media/video'], ['head', '/api/media/video'],
  ['get', '/api/media/audio'], ['head', '/api/media/audio'],
];
const call = (app, [method, path], headers = {}) => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return method === 'post' ? pending.send({}) : pending;
};
const expectNoCaptureEffects = () => {
  for (const effect of [mediaService.startVideoStream, mediaService.startAudioStream,
    mediaService.getVideoStream, mediaService.getAudioStream]) expect(effect).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('capture and live-stream operator authority (#11272)', () => {
  it('refuses remote and dev-proxied callers before device access or subscription to existing feeds', async () => {
    const video = new PassThrough();
    const audio = new PassThrough();
    mediaService.getVideoStream.mockReturnValue(video);
    mediaService.getAudioStream.mockReturnValue(audio);
    for (const [address, headers] of [
      ['192.0.2.10', {}],
      ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
      ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
    ]) {
      for (const operation of operations) {
        const response = await call(appFor(address), operation, headers);
        expect(response.status, operation.join(' ')).toBe(403);
        if (operation[0] !== 'head') expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
      }
    }
    expectNoCaptureEffects();
    for (const source of [video, audio]) {
      expect(source.listenerCount('data')).toBe(0);
      expect(source.listenerCount('end')).toBe(0);
    }
  });

  it('protects case and trailing-slash aliases, including implicit HEAD', async () => {
    for (const [method, path] of operations) {
      expect((await call(appFor(), [method, path.toUpperCase() + '//'])).status).toBe(403);
    }
    expectNoCaptureEffects();
  });

  it('rejects anonymous and legacy Basic callers when a password is enabled', async () => {
    auth.enabled = true;
    for (const [headers, status] of [
      [{}, 401],
      [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403],
    ]) {
      for (const operation of operations) expect((await call(appFor(), operation, headers)).status).toBe(status);
    }
    expectNoCaptureEffects();
  });

  it('preserves local capture and real human/agent sessions through the mounted streaming handlers', async () => {
    const human = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${human.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        mediaService.getVideoStream.mockReturnValue(Readable.from([Buffer.from([0xff, 0xd8, 0xff, 0xd9])]));
        mediaService.getAudioStream.mockReturnValue(Readable.from([Buffer.from('synthetic audio')]));
        const response = await call(appFor(address), operation, headers);
        expect(response.status, operation.join(' ')).toBe(200);
        if (operation[0] === 'get') {
          expect(response.headers['content-type']).toMatch(operation[1].endsWith('video') ? /^multipart/ : /^audio/);
          expect(response.text.length).toBeGreaterThan(0);
        }
      }
    }
    expect(mediaService.startVideoStream).toHaveBeenCalledTimes(3);
    expect(mediaService.startAudioStream).toHaveBeenCalledTimes(3);
    expect(mediaService.getVideoStream).toHaveBeenCalledTimes(6);
    expect(mediaService.getAudioStream).toHaveBeenCalledTimes(6);
  });

  it('keeps status, device discovery and stop behavior available', async () => {
    const app = appFor();
    for (const path of ['/api/media/status', '/api/media/devices']) expect((await request(app).get(path)).status).toBe(200);
    expect((await request(app).post('/api/media/stop').send({})).status).toBe(200);
    expect(mediaService.stopAll).toHaveBeenCalledOnce();
    expectNoCaptureEffects();
  });
});
