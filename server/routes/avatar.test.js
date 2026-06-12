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

  describe('variant resolution', () => {
    it('serves a named variant from the avatar dir', async () => {
      existsSync.mockReturnValue(true);
      createReadStream.mockReturnValue(Readable.from([Buffer.from('VARIANT-GLB')]));
      const res = await request(buildApp()).get('/api/avatar/model.glb?variant=mini-male-c');
      expect(res.status).toBe(200);
      expect(res.text).toBe('VARIANT-GLB');
      // The resolved path must stay inside the avatar dir with .glb appended.
      expect(createReadStream).toHaveBeenCalledWith('/mock/data/avatar/mini-male-c.glb');
    });

    it('rejects path-traversal / illegal variant names with 404', async () => {
      existsSync.mockReturnValue(true);
      // Stub the stream so the empty-string fallback (which hits the default
      // model.glb GET success path) is deterministic in isolation — don't rely
      // on a prior test's mockReturnValue leaking through vi.clearAllMocks().
      createReadStream.mockReturnValue(Readable.from([Buffer.from('DEFAULT-GLB')]));
      for (const bad of ['../secret', 'a/b', 'foo.glb', 'UP', '']) {
        const res = await request(buildApp()).get(`/api/avatar/model.glb?variant=${encodeURIComponent(bad)}`);
        // Empty string falls back to default model.glb (200); the rest are 404.
        if (bad === '') {
          expect(res.status).toBe(200);
        } else {
          expect(res.status).toBe(404);
        }
      }
    });

    // The client probes with HEAD before GET, so the HEAD handler runs the
    // same resolveVariant() guard — pin it independently of the GET path.
    it('HEAD honors a valid variant and rejects traversal', async () => {
      existsSync.mockReturnValue(true);
      statSync.mockReturnValue({ size: 5 });
      const ok = await request(buildApp()).head('/api/avatar/model.glb?variant=mini-male-c');
      expect(ok.status).toBe(200);
      expect(ok.headers['content-type']).toBe('model/gltf-binary');
      const bad = await request(buildApp()).head('/api/avatar/model.glb?variant=../secret');
      expect(bad.status).toBe(404);
    });
  });
});
