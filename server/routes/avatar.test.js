import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { Readable } from 'stream';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  createReadStream: vi.fn()
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' }
}));

import { existsSync, statSync, createReadStream } from 'fs';
import avatarRoutes from './avatar.js';

const buildApp = () => {
  const app = express();
  app.use('/api/avatar', avatarRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('avatar routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /model.glb', () => {
    it('returns 404 JSON when file is missing', async () => {
      existsSync.mockReturnValue(false);
      const res = await request(buildApp()).get('/api/avatar/model.glb');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/avatar model/i);
    });

    it('streams model.glb content with correct headers', async () => {
      existsSync.mockReturnValue(true);
      const fakeStream = Readable.from([Buffer.from('GLB-FAKE-CONTENT')]);
      createReadStream.mockReturnValue(fakeStream);

      const res = await request(buildApp()).get('/api/avatar/model.glb');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('model/gltf-binary');
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      expect(res.text).toBe('GLB-FAKE-CONTENT');
    });

    it('responds with 404 when stream errors with ENOENT before headers sent', async () => {
      existsSync.mockReturnValue(true);
      const errStream = new Readable({
        read() {
          process.nextTick(() => {
            const err = new Error('not found');
            err.code = 'ENOENT';
            this.emit('error', err);
          });
        }
      });
      createReadStream.mockReturnValue(errStream);

      const res = await request(buildApp()).get('/api/avatar/model.glb');
      expect(res.status).toBe(404);
      // The route sets Content-Type to gltf-binary before piping; res.json() does
      // not overwrite an existing Content-Type, so the body arrives as text.
      expect(JSON.parse(res.text).error).toMatch(/unavailable/i);
    });

    it('responds with 500 on non-ENOENT stream error before headers sent', async () => {
      existsSync.mockReturnValue(true);
      const errStream = new Readable({
        read() {
          process.nextTick(() => {
            const err = new Error('disk read failed');
            err.code = 'EIO';
            this.emit('error', err);
          });
        }
      });
      createReadStream.mockReturnValue(errStream);

      const res = await request(buildApp()).get('/api/avatar/model.glb');
      expect(res.status).toBe(500);
    });
  });
});
