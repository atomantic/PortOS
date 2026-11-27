import { expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { defaultRequestBody } from '../lib/defaultRequestBody.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { isHostControlRoute } from '../lib/hostControlRoutes.js';
import router from './voiceAvatar.js';
import { getAvatarStatus, manageAvatar, renderAvatar, renderAvatarIdle } from '../services/voice/avatarRuntime.js';

vi.mock('../services/voice/avatarRuntime.js', () => ({
  getAvatarStatus: vi.fn(), manageAvatar: vi.fn(), renderAvatar: vi.fn(), renderAvatarIdle: vi.fn(),
}));

const base = '/api/voice/avatar';
const canned = { supported: true, installed: true, updateAvailable: false, phase: 'running', detail: '' };
const app = express();
app.use(express.json());
app.use(defaultRequestBody);
app.use(base, router);
app.use(errorMiddleware);
beforeEach(() => {
  vi.resetAllMocks();
  getAvatarStatus.mockResolvedValue(canned);
  manageAvatar.mockResolvedValue(canned);
});

it('requires host control and explicit weight terms without exposing paths or commands', async () => {
  expect(isHostControlRoute('GET', base + '/status')).toBe(true);
  expect(isHostControlRoute('POST', base + '/runtime')).toBe(true);
  expect(isHostControlRoute('POST', base + '/frames')).toBe(true);
  expect(isHostControlRoute('POST', base + '/idle')).toBe(true);
  expect((await request(app).get(base + '/status')).body).toEqual(canned);
  expect((await request(app).post(base + '/runtime').send({ action: 'install' })).status).toBe(400);
  expect((await request(app).post(base + '/runtime').send({ action: 'start', binary: '/bin/sh' })).status).toBe(400);
  expect(manageAvatar).not.toHaveBeenCalled();
  expect((await request(app).post(base + '/runtime').send({ action: 'install', acceptTerms: true })).status).toBe(200);
  expect(manageAvatar).toHaveBeenCalledWith('install');
});

it('accepts binary output WAV and incrementally serializes only the timestamped frames', async () => {
  const wave = Buffer.alloc(44);
  wave.write('RIFF', 0);
  wave.write('WAVE', 8);
  const frame = { index: 0, timeMs: 0, jpeg: 'fixture' };
  renderAvatar.mockImplementation(async (_bytes, { onFrame }) => { onFrame(frame); });
  const res = await request(app).post(base + '/frames').set('Content-Type', 'audio/wav').send(wave);
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['content-type']).toContain('application/x-ndjson');
  expect(res.text).toBe(JSON.stringify(frame) + '\n');
  expect(renderAvatar.mock.calls[0][0]).toEqual(wave);
});

it('rejects invalid and oversized wave bodies before using the renderer', async () => {
  expect((await request(app).post(base + '/frames').set('Content-Type', 'audio/wav').send(Buffer.alloc(44))).status).toBe(400);
  expect((await request(app).post(base + '/frames').set('Content-Type', 'audio/wav').send(Buffer.alloc(2 * 1024 * 1024 + 1))).status).toBe(413);
  expect(renderAvatar).not.toHaveBeenCalled();
});

it('streams continuous idle avatar frames for valid stages and rejects unknown stages', async () => {
  const frame = { index: 0, timeMs: 0, jpeg: 'idle-fixture' };
  renderAvatarIdle.mockImplementation(async ({ onFrame }) => { onFrame(frame); });
  const res = await request(app).post(base + '/idle').send({ stage: 'listening' });
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['content-type']).toContain('application/x-ndjson');
  expect(res.text).toBe(JSON.stringify(frame) + '\n');
  expect(renderAvatarIdle).toHaveBeenCalledWith(expect.objectContaining({ stage: 'listening' }));

  expect((await request(app).post(base + '/idle').send({ stage: 'dancing' })).status).toBe(400);
});
