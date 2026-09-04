import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join as joinPath } from 'path';
import express from 'express';
import { Readable } from 'stream';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('fs', () => ({
  createReadStream: vi.fn()
}));

vi.mock('fs/promises', () => ({
  stat: vi.fn()
}));

vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PATHS: { data: '/mock/data', imageTo3d: '/mock/image-to-3d' },
  pathExists: vi.fn()
}));

vi.mock('../services/imageTo3d/db.js', () => ({
  getModel: vi.fn(),
  listModels: vi.fn(),
}));

import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { pathExists } from '../lib/fileUtils.js';
import { getModel, listModels } from '../services/imageTo3d/db.js';
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
      pathExists.mockResolvedValue(false);
      const res = await request(buildApp()).get('/api/avatar/model.glb');
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/avatar model/i);
    });

    it('streams model.glb content with correct headers', async () => {
      pathExists.mockResolvedValue(true);
      const fakeStream = Readable.from([Buffer.from('GLB-FAKE-CONTENT')]);
      createReadStream.mockReturnValue(fakeStream);

      const res = await request(buildApp()).get('/api/avatar/model.glb');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('model/gltf-binary');
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      expect(res.text).toBe('GLB-FAKE-CONTENT');
    });

    it('responds with 404 when stream errors with ENOENT before headers sent', async () => {
      pathExists.mockResolvedValue(true);
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
      const body = JSON.parse(res.text);
      expect(body.error).toMatch(/unavailable/i);
      // Standard error envelope: { error, code, timestamp } — same shape
      // errorMiddleware stamps everywhere else (regression for issue-1836).
      expect(body.code).toBe('NOT_FOUND');
      expect(typeof body.timestamp).toBe('number');
    });

    it('responds with 500 + full error envelope on non-ENOENT stream error before headers sent', async () => {
      pathExists.mockResolvedValue(true);
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
      const body = JSON.parse(res.text);
      expect(body.error).toMatch(/unavailable/i);
      expect(body.code).toBe('INTERNAL_ERROR');
      expect(typeof body.timestamp).toBe('number');
    });
  });

  describe('variant resolution', () => {
    it('serves a named variant from the avatar dir', async () => {
      pathExists.mockResolvedValue(true);
      createReadStream.mockReturnValue(Readable.from([Buffer.from('VARIANT-GLB')]));
      const res = await request(buildApp()).get('/api/avatar/model.glb?variant=mini-male-c');
      expect(res.status).toBe(200);
      expect(res.text).toBe('VARIANT-GLB');
      // The resolved path must stay inside the avatar dir with .glb appended.
      expect(createReadStream).toHaveBeenCalledWith(joinPath('/mock/data', 'avatar', 'mini-male-c.glb'));
    });

    it('rejects path-traversal / illegal variant names with 404', async () => {
      pathExists.mockResolvedValue(true);
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
      // HEAD stats the resolved path directly (no separate existence check) —
      // a resolved stat means the file is present.
      stat.mockResolvedValue({ size: 5 });
      const ok = await request(buildApp()).head('/api/avatar/model.glb?variant=mini-male-c');
      expect(ok.status).toBe(200);
      expect(ok.headers['content-type']).toBe('model/gltf-binary');
      const bad = await request(buildApp()).head('/api/avatar/model.glb?variant=../secret');
      expect(bad.status).toBe(404);
    });
  });

  describe('rigged record variants', () => {
    const readyRecord = {
      id: 'image3d-record-1',
      name: 'Example Character',
      retarget: { status: 'ready', retargetId: 'retarget-run-1', clip: 'Idle' },
    };

    it('serves a ready record animated GLB through the rigged spelling', async () => {
      getModel.mockResolvedValue(readyRecord);
      pathExists.mockResolvedValue(true);
      createReadStream.mockReturnValue(Readable.from([Buffer.from('ANIMATED-GLB')]));
      const res = await request(buildApp()).get('/api/avatar/model.glb?variant=rigged-image3d-record-1');
      expect(res.status).toBe(200);
      expect(res.text).toBe('ANIMATED-GLB');
      // The resolved path stays inside the record's retarget publish dir.
      expect(createReadStream).toHaveBeenCalledWith(joinPath(
        '/mock/image-to-3d', 'image3d-record-1', 'retarget', 'retarget-run-1', 'character.animated.glb',
      ));
    });

    it('HEAD honors a ready rigged spelling', async () => {
      getModel.mockResolvedValue(readyRecord);
      stat.mockResolvedValue({ size: 7 });
      const res = await request(buildApp()).head('/api/avatar/model.glb?variant=rigged-image3d-record-1');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('model/gltf-binary');
    });

    it('404s a rigged spelling for unknown, unready, and traversal ids alike', async () => {
      pathExists.mockResolvedValue(false);
      // Unknown record.
      getModel.mockResolvedValue(null);
      const missing = await request(buildApp()).get('/api/avatar/model.glb?variant=rigged-image3d-nope');
      expect(missing.status).toBe(404);
      expect(missing.body.error).toMatch(/animated character/i);
      // Rig-only record (no verified retarget yet) — never a half-animated file.
      getModel.mockResolvedValue({ id: 'image3d-record-2', retarget: { status: 'retargeting' } });
      const unready = await request(buildApp()).get('/api/avatar/model.glb?variant=rigged-image3d-record-2');
      expect(unready.status).toBe(404);
      // Traversal inside the rigged namespace never reaches the record lookup.
      getModel.mockClear();
      const traversal = await request(buildApp()).get('/api/avatar/model.glb?variant=rigged-../secret');
      expect(traversal.status).toBe(404);
      expect(getModel).not.toHaveBeenCalled();
    });
  });

  describe('GET /rigged', () => {
    it('lists only ready records with their clip coverage attached', async () => {
      listModels.mockResolvedValue([
        { id: 'image3d-animated-1', name: 'Example Dancer', retarget: { status: 'ready', retargetId: 'retarget-1', clip: 'Dance' } },
        { id: 'image3d-rig-only-1', name: 'Not Yet', rig: { status: 'ready' }, retarget: null },
        { id: 'image3d-failed-1', name: 'Failed', retarget: { status: 'failed' } },
      ]);
      const res = await request(buildApp()).get('/api/avatar/rigged');
      expect(res.status).toBe(200);
      expect(res.body.records).toHaveLength(1);
      expect(res.body.records[0]).toMatchObject({
        id: 'image3d-animated-1',
        name: 'Example Dancer',
        variant: 'rigged-image3d-animated-1',
        assetUrl: '/api/avatar/model.glb?variant=rigged-image3d-animated-1',
        clip: 'Dance',
      });
      // The single retargeted clip drives the coverage answer: Dance covers
      // ideating, everything else honestly reports missing.
      expect(res.body.records[0].coverage.coveredStates).toContain('ideating');
      expect(res.body.records[0].coverage.missingStates.length).toBeGreaterThan(0);
      expect(res.body.records[0].coverage.complete).toBe(false);
    });

    it('answers an empty list when no record is animated yet', async () => {
      listModels.mockResolvedValue([]);
      const res = await request(buildApp()).get('/api/avatar/rigged');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ records: [] });
    });
  });
});
