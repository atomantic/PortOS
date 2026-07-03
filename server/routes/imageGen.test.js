import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import imageGenRoutes from './imageGen.js';
import * as fileUtils from '../lib/fileUtils.js';
import * as regen from '../services/imageGen/regen.js';
import * as mediaSketches from '../services/mediaSketches.js';
import { writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join as pathJoin } from 'path';

vi.mock('../services/imageGen/index.js', () => ({
  checkConnection: vi.fn(),
  generateImage: vi.fn(),
  generateAvatar: vi.fn(),
  attachSseClient: vi.fn(() => false),
  cancel: vi.fn(() => false),
  IMAGE_GEN_MODE: { EXTERNAL: 'external', LOCAL: 'local', CODEX: 'codex' },
  IMAGE_GEN_MODES: ['external', 'local', 'codex'],
  // Mirror the real precedence by delegating to the same helper the prod
  // resolver uses — keeps test mock and prod in lock-step automatically.
  // Legacy `autoClean: true` no longer carries into denoise (lossy, opt-in only).
  resolveImageCleaners: (body, settings, mode) => {
    const cfg = settings?.imageGen?.[mode] || {};
    const saved = {
      cleanC2PA: typeof cfg.cleanC2PA === 'boolean' ? cfg.cleanC2PA : true,
      denoise: typeof cfg.denoise === 'boolean' ? cfg.denoise : false,
    };
    return {
      cleanC2PA: typeof body?.cleanC2PA === 'boolean' ? body.cleanC2PA : saved.cleanC2PA,
      denoise: typeof body?.denoise === 'boolean' ? body.denoise : saved.denoise,
    };
  },
  local: {
    listImageModels: vi.fn(() => []),
    listLoraFilenames: vi.fn(async () => []),
    listGallery: vi.fn(async () => []),
    deleteImage: vi.fn(async () => ({ ok: true })),
    assertGalleryFilename: vi.fn(),
    readImageSidecar: vi.fn(async () => ({ path: '', metadata: {} })),
    saveUploadedGalleryImage: vi.fn(async () => ({ filename: 'upload-abcd1234.png', path: '/data/images/upload-abcd1234.png' })),
  },
}));

// Default to external mode in tests so /generate goes through the dispatcher.
// Local-mode tests below override the settings mock to flip into queue mode.
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { mode: 'external' } })),
}));

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(({ kind }) => ({ jobId: `mock-${kind}-job`, position: 1, status: 'queued' })),
  attachSseClient: vi.fn(() => false),
  cancelJob: vi.fn(async () => ({ ok: true, status: 'canceling' })),
  listJobs: vi.fn(() => []),
}));

// The /generate route resolves an optional universeRun collection target via
// findOrCreateUniverseCollection. Mock it so the universeRun test asserts the
// tag-resolution wiring without touching real collection storage.
vi.mock('../services/mediaCollections.js', () => ({
  findOrCreateUniverseCollection: vi.fn(async ({ universeId }) => ({ id: `col-${universeId}` })),
}));

// POST /avatar folds character-avatar persistence in when persistToCharacter is
// set. Mock the service so the test asserts the wiring without touching the
// real singleton character store.
vi.mock('../services/character.js', () => ({
  setAvatar: vi.fn(async (avatarPath) => ({ name: 'Gandalf', avatarPath })),
}));

// HOST_ARCH is read at request time inside `buildSetupCheck`, so backing it
// with a hoisted mutable holder + getter lets tests flip between arm64 and
// x86_64 hosts without re-mocking. Default arm64 keeps every existing test
// behaving as before.
const hostArchHolder = vi.hoisted(() => ({ value: 'arm64' }));

vi.mock('../lib/pythonSetup.js', () => ({
  REQUIRED_PACKAGES: ['mflux', 'mlx'],
  get HOST_ARCH() { return hostArchHolder.value; },
  isAllowedPython: vi.fn(() => true),
  probePythonHealth: vi.fn(async () => ({
    installed: ['mflux', 'mlx'], missing: [], missingPip: [],
    externallyManaged: false, interpreterArch: 'arm64',
  })),
  detectPython: vi.fn(async () => '/usr/bin/python3'),
  detectArm64Python: vi.fn(async () => null),
  installPackages: vi.fn(() => ({ promise: Promise.resolve(), kill: vi.fn() })),
  createVenv: vi.fn(async () => '/fake/venv/python'),
  pipNameFor: (n) => n,
  resolveFlux2Python: vi.fn(() => null),
  FLUX2_VENV_DEFAULT: '/fake/flux2-venv',
  installFlux2Venv: vi.fn(),
  isFlux2VenvHealthy: vi.fn(async () => true),
}));

// Stat the python binary to key the cache. Override per-test for mtime
// changes; default to a stable mtime so the cache HIT path works.
const mockStat = vi.fn(async () => ({ mtimeMs: 1_700_000_000_000 }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, stat: (path) => mockStat(path) };
});

import * as imageGen from '../services/imageGen/index.js';
import * as characterService from '../services/character.js';
import * as mediaJobQueue from '../services/mediaJobQueue/index.js';
import { getSettings } from '../services/settings.js';
import { findOrCreateUniverseCollection } from '../services/mediaCollections.js';

describe('Image Gen Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/image-gen', imageGenRoutes);
    app.use(errorMiddleware);
    vi.clearAllMocks();
  });

  describe('GET /api/image-gen/status', () => {
    it('should return connection status', async () => {
      imageGen.checkConnection.mockResolvedValue({ connected: true, model: 'flux-v1' });

      const response = await request(app).get('/api/image-gen/status');

      expect(response.status).toBe(200);
      expect(response.body.connected).toBe(true);
      expect(response.body.model).toBe('flux-v1');
    });

    it('should return disconnected status', async () => {
      imageGen.checkConnection.mockResolvedValue({ connected: false, reason: 'No SD API URL configured' });

      const response = await request(app).get('/api/image-gen/status');

      expect(response.status).toBe(200);
      expect(response.body.connected).toBe(false);
    });

    it('forwards a valid ?mode= query into checkConnection', async () => {
      imageGen.checkConnection.mockResolvedValue({ connected: true, mode: 'codex' });
      const response = await request(app).get('/api/image-gen/status?mode=codex');
      expect(response.status).toBe(200);
      expect(imageGen.checkConnection).toHaveBeenCalledWith({ mode: 'codex' });
    });

    it('ignores an invalid ?mode= query and uses the saved default', async () => {
      imageGen.checkConnection.mockResolvedValue({ connected: true, mode: 'external' });
      const response = await request(app).get('/api/image-gen/status?mode=bogus');
      expect(response.status).toBe(200);
      expect(imageGen.checkConnection).toHaveBeenCalledWith({ mode: undefined });
    });

    // Express turns ?mode=a&mode=b into an array — without the
    // typeof === 'string' guard, that array would either match
    // IMAGE_GEN_MODES.includes() falsely or propagate as a non-string
    // mode to the dispatcher.
    it('ignores a duplicated-key ?mode= array', async () => {
      imageGen.checkConnection.mockResolvedValue({ connected: true, mode: 'external' });
      const response = await request(app).get('/api/image-gen/status?mode=local&mode=codex');
      expect(response.status).toBe(200);
      expect(imageGen.checkConnection).toHaveBeenCalledWith({ mode: undefined });
    });
  });

  describe('POST /api/image-gen/generate', () => {
    it('should generate an image', async () => {
      imageGen.generateImage.mockResolvedValue({
        generationId: 'gen-001',
        filename: 'test.png',
        path: '/data/images/test.png'
      });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fantasy landscape' });

      expect(response.status).toBe(200);
      expect(response.body.path).toBe('/data/images/test.png');
      expect(imageGen.generateImage).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'a fantasy landscape' }));
    });

    it('accepts a missing/empty prompt (i2i / edit / unconditional), defaulting it to empty', async () => {
      imageGen.generateImage.mockResolvedValue({
        generationId: 'gen-empty',
        filename: 'test.png',
        path: '/data/images/test.png'
      });
      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({});

      expect(response.status).toBe(200);
      expect(imageGen.generateImage).toHaveBeenCalledWith(expect.objectContaining({ prompt: '' }));
    });

    it('rejects a Codex text-to-image request with no prompt and no init image (synchronous 400)', async () => {
      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ mode: 'codex' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should validate width and height bounds', async () => {
      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'test', width: 50000 });

      expect(response.status).toBe(400);
    });

    it('should pass optional parameters', async () => {
      imageGen.generateImage.mockResolvedValue({ generationId: 'gen-002', filename: 'test2.png', path: '/data/images/test2.png' });

      await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'test', width: 512, height: 768, steps: 30, cfgScale: 7, seed: 42 });

      expect(imageGen.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'test', width: 512, height: 768, steps: 30, cfgScale: 7, seed: 42 })
      );
    });

    // referenceStrengths is the multi-reference companion to the
    // multipart referenceImage1..4 uploads. The schema accepts the array on a
    // JSON body too so a future internal caller (no files attached) doesn't
    // 400 just by listing weights.
    it('accepts a referenceStrengths array (0..1, max 4 entries)', async () => {
      imageGen.generateImage.mockResolvedValue({ generationId: 'gen-ref', filename: 'r.png', path: '/data/images/r.png' });
      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'multi-ref', referenceStrengths: [0.8, 0.4] });
      expect(response.status).toBe(200);
    });

    it('rejects a referenceStrengths entry outside 0..1', async () => {
      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'multi-ref', referenceStrengths: [0.5, 1.7] });
      expect(response.status).toBe(400);
    });

    it('rejects more than 4 referenceStrengths entries', async () => {
      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'multi-ref', referenceStrengths: [0.1, 0.2, 0.3, 0.4, 0.5] });
      expect(response.status).toBe(400);
    });

    // Local mode goes through the mediaJobQueue rather than calling
    // generateImage synchronously; the route returns immediately with
    // { jobId, status: 'queued', position } so the UI can attach SSE.
    it('local mode enqueues through mediaJobQueue and returns queued status', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-job-001', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fox in a forest' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('queued');
      expect(response.body.position).toBe(1);
      expect(response.body.mode).toBe('local');
      expect(response.body.jobId).toBe('queued-job-001');
      expect(response.body.generationId).toBe('queued-job-001');
      expect(response.body.path).toBe('/data/images/queued-job-001.png');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'image',
        params: expect.objectContaining({ prompt: 'a fox in a forest', pythonPath: '/usr/bin/python3' }),
      }));
      // Synchronous generateImage MUST NOT be called in local mode — the
      // queue takes ownership of the job lifecycle.
      expect(imageGen.generateImage).not.toHaveBeenCalled();
    });

    it('local mode maps cfgScale to guidance before enqueueing', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-job-cfg', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fox in a forest', cfgScale: 6.5 });

      expect(response.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'image',
        params: expect.objectContaining({ cfgScale: 6.5, guidance: 6.5 }),
      }));
    });

    // The per-request `mode` override flips into queue mode even when the
    // saved default is external — protects against future regressions where
    // someone hard-codes settings.imageGen.mode as the only mode source.
    it('per-request mode=local override enqueues even when settings default is external', async () => {
      // Local mode now validates pythonPath up-front (mflux model needs it),
      // so the test must supply a configured local section. The override
      // contract — explicit `mode: 'local'` flips into queue mode regardless
      // of the saved default — is still what's being asserted here.
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'external', local: { pythonPath: '/usr/bin/python3' } } });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-job-002', position: 2, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a wizard tower', mode: 'local' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('queued');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image' }));
      expect(imageGen.generateImage).not.toHaveBeenCalled();
    });

    // The base-style probe passes a `universeRun` identity so the SERVER files
    // the finished render into the universe collection. The route must resolve
    // the collectionId server-side and tag the queued job — the front-end never
    // sends a collectionId or does post-generation bookkeeping.
    describe('universeRun collection target', () => {
      it('resolves the collection server-side and tags the queued job', async () => {
        getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } });
        mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-style', position: 1, status: 'queued' });

        const response = await request(app)
          .post('/api/image-gen/generate')
          .send({
            prompt: 'a moody noir skyline',
            universeRun: { universeId: 'uni-1', universeName: 'NoirVerse', label: 'Base style', category: 'style' },
          });

        expect(response.status).toBe(200);
        expect(findOrCreateUniverseCollection).toHaveBeenCalledWith(
          expect.objectContaining({ universeId: 'uni-1', universeName: 'NoirVerse' }),
        );
        const [call] = mediaJobQueue.enqueueJob.mock.calls;
        // collectionId is server-resolved (never client-supplied), runId minted,
        // label/category preserved — exactly what universeBuilderCollectionHook reads.
        expect(call[0].params.universeRun).toEqual(expect.objectContaining({
          universeId: 'uni-1',
          collectionId: 'col-uni-1',
          label: 'Base style',
          category: 'style',
        }));
        expect(typeof call[0].params.universeRun.runId).toBe('string');
      });

      it('drops the tag (still renders) when collection provisioning fails', async () => {
        getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } });
        mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-style-2', position: 1, status: 'queued' });
        findOrCreateUniverseCollection.mockRejectedValueOnce(new Error('db down'));

        const response = await request(app)
          .post('/api/image-gen/generate')
          .send({
            prompt: 'a moody noir skyline',
            universeRun: { universeId: 'uni-2', universeName: 'FailVerse', label: 'Base style', category: 'style' },
          });

        // The render still proceeds — a collection-filing miss must not fail it.
        expect(response.status).toBe(200);
        const [call] = mediaJobQueue.enqueueJob.mock.calls;
        expect(call[0].params.universeRun).toBeUndefined();
      });

      it('ignores universeRun without a universeId (no collection resolution)', async () => {
        getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } });
        mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-plain', position: 1, status: 'queued' });

        const response = await request(app)
          .post('/api/image-gen/generate')
          .send({ prompt: 'a plain render' });

        expect(response.status).toBe(200);
        expect(findOrCreateUniverseCollection).not.toHaveBeenCalled();
        const [call] = mediaJobQueue.enqueueJob.mock.calls;
        expect(call[0].params.universeRun).toBeUndefined();
      });

      // #1395 — section-local canon renders carry an `entryRef` so the
      // completion hook durably appends the render to the entry's imageRefs[].
      it('carries the section-local entryRef into the queued job tag', async () => {
        getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } });
        mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-section', position: 1, status: 'queued' });

        const response = await request(app)
          .post('/api/image-gen/generate')
          .send({
            prompt: 'a confident pyromancer',
            universeRun: {
              universeId: 'uni-3',
              universeName: 'CanonVerse',
              label: 'Ash',
              category: 'characters',
              entryRef: { kind: 'canon', kindKey: 'characters', id: 'char-ash' },
            },
          });

        expect(response.status).toBe(200);
        const [call] = mediaJobQueue.enqueueJob.mock.calls;
        expect(call[0].params.universeRun).toEqual(expect.objectContaining({
          universeId: 'uni-3',
          collectionId: 'col-uni-3',
          entryRef: { kind: 'canon', kindKey: 'characters', id: 'char-ash' },
        }));
      });

      it('rejects a canon entryRef missing its kindKey (would no-op the append)', async () => {
        // Zod validation rejects before prepareGenerateParams reads settings, so
        // no getSettings/enqueueJob mock is primed here — priming an unconsumed
        // mockResolvedValueOnce would leak into the next test (clearAllMocks does
        // not drain the once-queue).
        const response = await request(app)
          .post('/api/image-gen/generate')
          .send({
            prompt: 'a confident pyromancer',
            universeRun: {
              universeId: 'uni-5',
              universeName: 'CanonVerse',
              entryRef: { kind: 'canon', id: 'char-ash' }, // no kindKey
            },
          });

        expect(response.status).toBe(400);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('preserves the entryRef even when collection provisioning fails', async () => {
        getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } });
        mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-section-2', position: 1, status: 'queued' });
        findOrCreateUniverseCollection.mockRejectedValueOnce(new Error('db down'));

        const response = await request(app)
          .post('/api/image-gen/generate')
          .send({
            prompt: 'a confident pyromancer',
            universeRun: {
              universeId: 'uni-4',
              universeName: 'CanonVerse',
              entryRef: { kind: 'canon', kindKey: 'characters', id: 'char-ash' },
            },
          });

        expect(response.status).toBe(200);
        const [call] = mediaJobQueue.enqueueJob.mock.calls;
        // The durable imageRefs[] append must not depend on the gallery
        // collection existing — entryRef survives, collectionId/runId don't.
        expect(call[0].params.universeRun).toEqual({
          universeId: 'uni-4',
          entryRef: { kind: 'canon', kindKey: 'characters', id: 'char-ash' },
        });
      });
    });

    // Durable catalog attach (#1359): the Catalog ingredient editor's Generate
    // button passes `catalogIngredientId` so the queued job carries a
    // `catalogAttach` tag the completion hook reads to file the render even if
    // the page unmounts. The route collapses the raw fields into the tag and
    // drops them from params.
    describe('catalogAttach tag', () => {
      it('folds catalogIngredientId into a catalogAttach job tag and drops the raw field', async () => {
        getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } });
        mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-cat', position: 1, status: 'queued' });

        const response = await request(app)
          .post('/api/image-gen/generate')
          .send({ prompt: 'a catalog hero', catalogIngredientId: 'ing-42' });

        expect(response.status).toBe(200);
        const [call] = mediaJobQueue.enqueueJob.mock.calls;
        expect(call[0].params.catalogAttach).toEqual({ ingredientId: 'ing-42' });
        // Raw fields are stripped — only the canonical tag persists in job.params.
        expect(call[0].params.catalogIngredientId).toBeUndefined();
        expect(call[0].params.catalogMediaKind).toBeUndefined();
      });

      it('preserves an explicit catalogMediaKind in the tag', async () => {
        getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } });
        mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-cat-kind', position: 1, status: 'queued' });

        const response = await request(app)
          .post('/api/image-gen/generate')
          .send({ prompt: 'a reference shot', catalogIngredientId: 'ing-7', catalogMediaKind: 'reference' });

        expect(response.status).toBe(200);
        const [call] = mediaJobQueue.enqueueJob.mock.calls;
        expect(call[0].params.catalogAttach).toEqual({ ingredientId: 'ing-7', kind: 'reference' });
      });

      it('rejects an invalid catalogMediaKind', async () => {
        const response = await request(app)
          .post('/api/image-gen/generate')
          .send({ prompt: 'x', catalogIngredientId: 'ing-9', catalogMediaKind: 'thumbnail' });
        expect(response.status).toBe(400);
      });

      it('omits catalogAttach when no catalogIngredientId is sent', async () => {
        getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } });
        mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-nocat', position: 1, status: 'queued' });

        const response = await request(app)
          .post('/api/image-gen/generate')
          .send({ prompt: 'untagged render' });

        expect(response.status).toBe(200);
        const [call] = mediaJobQueue.enqueueJob.mock.calls;
        expect(call[0].params.catalogAttach).toBeUndefined();
      });
    });

    // Local mode without a configured pythonPath now rejects up-front (400)
    // rather than enqueueing a job that can never run. The queue is meant to
    // serialize concurrent renders, not to absorb hard configuration errors.
    it('local mode with missing pythonPath returns 400 IMAGE_GEN_NOT_CONFIGURED', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local' } }); // no `local.pythonPath`

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fox in a forest' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/not configured/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // z-image and ernie use the FLUX.2 venv — they must NOT require pythonPath.
    it('local mode with z-image model and missing pythonPath still enqueues (exempted)', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local' } }); // no pythonPath
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'mock-image-job', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fox in a forest', modelId: 'z-image-turbo-bf16' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('queued');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalled();
    });

    it('local mode with ernie model and missing pythonPath still enqueues (exempted)', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local' } }); // no pythonPath
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'mock-image-job', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a wizard tower', modelId: 'ernie-image' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('queued');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalled();
    });

    // Codex mode now goes through the mediaJobQueue (codex lane), so a
    // burst of writers-room storyboard renders queues against itself
    // instead of failing the second-and-onwards calls with 409
    // IMAGE_GEN_BUSY.
    it('codex mode enqueues through mediaJobQueue and returns queued status', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'codex', codex: { enabled: true, codexPath: '/usr/local/bin/codex', model: 'gpt-5.4' } },
      });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-codex-001', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a tavern at dusk' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('queued');
      expect(response.body.mode).toBe('codex');
      expect(response.body.model).toBe('gpt-5.4');
      expect(response.body.jobId).toBe('queued-codex-001');
      expect(response.body.path).toBe('/data/images/queued-codex-001.png');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'image',
        params: expect.objectContaining({
          mode: 'codex',
          codexPath: '/usr/local/bin/codex',
          model: 'gpt-5.4',
          prompt: 'a tavern at dusk',
        }),
      }));
      // Synchronous generateImage MUST NOT be called in codex mode either —
      // the queue takes ownership.
      expect(imageGen.generateImage).not.toHaveBeenCalled();
    });

    // Per-request codex override: even when the saved default is external,
    // an explicit `mode: 'codex'` on the payload (e.g. the writers-room
    // storyboard chip strip) flips into queue mode so renders serialize.
    it('per-request mode=codex override enqueues even when settings default is external', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'external', codex: { enabled: true, model: 'gpt-5.4' } },
      });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-codex-002', position: 2, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a wizard tower', mode: 'codex' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('queued');
      expect(response.body.mode).toBe('codex');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'image',
        params: expect.objectContaining({ mode: 'codex' }),
      }));
      expect(imageGen.generateImage).not.toHaveBeenCalled();
    });

    describe('cleaner resolution (body wins over saved setting)', () => {
      it('external mode: body denoise=true overrides saved setting=false', async () => {
        getSettings.mockResolvedValueOnce({
          imageGen: { mode: 'external', external: { cleanC2PA: false, denoise: false } },
        });
        imageGen.generateImage.mockResolvedValue({ filename: 'x.png', path: '/data/images/x.png' });

        await request(app).post('/api/image-gen/generate').send({ prompt: 'p', denoise: true });

        expect(imageGen.generateImage).toHaveBeenCalledWith(expect.objectContaining({ denoise: true, cleanC2PA: false }));
      });

      it('external mode: omitted body inherits saved cleanC2PA=true + denoise=false', async () => {
        getSettings.mockResolvedValueOnce({
          imageGen: { mode: 'external', external: { cleanC2PA: true, denoise: false } },
        });
        imageGen.generateImage.mockResolvedValue({ filename: 'x.png', path: '/data/images/x.png' });

        await request(app).post('/api/image-gen/generate').send({ prompt: 'p' });

        expect(imageGen.generateImage).toHaveBeenCalledWith(expect.objectContaining({ cleanC2PA: true, denoise: false }));
      });

      it('local mode: body flags flow through into enqueued params', async () => {
        getSettings.mockResolvedValueOnce({
          imageGen: { mode: 'local', local: { pythonPath: '/p', cleanC2PA: false, denoise: false } },
        });

        await request(app).post('/api/image-gen/generate').send({ prompt: 'p', cleanC2PA: true, denoise: true });

        const [call] = mediaJobQueue.enqueueJob.mock.calls;
        expect(call[0].params.cleanC2PA).toBe(true);
        expect(call[0].params.denoise).toBe(true);
      });

      it('codex mode: body denoise=false overrides saved setting=true on enqueued params', async () => {
        getSettings.mockResolvedValueOnce({
          imageGen: { mode: 'codex', codex: { enabled: true, cleanC2PA: true, denoise: true } },
        });

        await request(app).post('/api/image-gen/generate').send({ prompt: 'p', denoise: false });

        const [call] = mediaJobQueue.enqueueJob.mock.calls;
        expect(call[0].params.denoise).toBe(false);
      });

      it('defaults to cleanC2PA=true + denoise=false when neither body nor settings specify', async () => {
        getSettings.mockResolvedValueOnce({ imageGen: { mode: 'external' } });
        imageGen.generateImage.mockResolvedValue({ filename: 'x.png', path: '/data/images/x.png' });

        await request(app).post('/api/image-gen/generate').send({ prompt: 'p' });

        expect(imageGen.generateImage).toHaveBeenCalledWith(expect.objectContaining({ cleanC2PA: true, denoise: false }));
      });

      it('legacy autoClean=true on settings does NOT silently enable denoise on read', async () => {
        // Pre-split installs persisted `autoClean: true`. We no longer carry
        // that into denoise — denoise is lossy (blurs text) and must be an
        // explicit opt-in. Upgrading users get cleanC2PA on (it defaults on
        // anyway) and denoise off until they explicitly toggle it.
        getSettings.mockResolvedValueOnce({
          imageGen: { mode: 'external', external: { autoClean: true } },
        });
        imageGen.generateImage.mockResolvedValue({ filename: 'x.png', path: '/data/images/x.png' });

        await request(app).post('/api/image-gen/generate').send({ prompt: 'p' });

        expect(imageGen.generateImage).toHaveBeenCalledWith(expect.objectContaining({ cleanC2PA: true, denoise: false }));
      });

      it('legacy autoClean=true on body maps to BOTH new flags via the coerceFormFields shim', async () => {
        getSettings.mockResolvedValueOnce({ imageGen: { mode: 'external' } });
        imageGen.generateImage.mockResolvedValue({ filename: 'x.png', path: '/data/images/x.png' });

        await request(app).post('/api/image-gen/generate').send({ prompt: 'p', autoClean: true });

        expect(imageGen.generateImage).toHaveBeenCalledWith(expect.objectContaining({ cleanC2PA: true, denoise: true }));
      });
    });

    // Edit-only models (Qwen-Image-Edit) require a source image. A text-only
    // submission must be rejected up-front (400) — enqueueing it would crash
    // the runner deep inside the diffusers QwenImageEditPipeline.
    it('local mode with an edit-only model and no init image returns 400 IMAGE_GEN_EDIT_IMAGE_REQUIRED', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local' } }); // qwen uses the flux2 venv — no pythonPath needed

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'make the sky purple', modelId: 'qwen-image-edit' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('IMAGE_GEN_EDIT_IMAGE_REQUIRED');
      expect(response.body.error).toMatch(/source image/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // Codex with the toggle off rejects up-front rather than enqueueing.
    it('codex mode with disabled toggle returns 400 CODEX_IMAGEGEN_DISABLED', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'codex', codex: { enabled: false } },
      });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fox' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/disabled/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/image-gen/avatar', () => {
    it('should generate an avatar', async () => {
      imageGen.generateAvatar.mockResolvedValue({
        generationId: 'gen-003',
        filename: 'avatar.png',
        path: '/data/images/avatar.png'
      });

      const response = await request(app)
        .post('/api/image-gen/avatar')
        .send({ name: 'Gandalf', characterClass: 'Wizard' });

      expect(response.status).toBe(200);
      expect(response.body.path).toBe('/data/images/avatar.png');
    });

    it('should accept empty body for default avatar and return a response shape', async () => {
      imageGen.generateAvatar.mockResolvedValue({
        generationId: 'gen-004',
        filename: 'default.png',
        path: '/data/images/default.png'
      });

      const response = await request(app)
        .post('/api/image-gen/avatar')
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.generationId).toBe('gen-004');
      expect(response.body.filename).toBe('default.png');
      expect(response.body.path).toBe('/data/images/default.png');
    });

    it('persists the rendered path onto the character when persistToCharacter is set', async () => {
      imageGen.generateAvatar.mockResolvedValue({
        generationId: 'gen-005',
        filename: 'avatar.png',
        path: '/data/images/avatar.png',
      });

      const response = await request(app)
        .post('/api/image-gen/avatar')
        .send({ name: 'Gandalf', characterClass: 'Wizard', persistToCharacter: true });

      expect(response.status).toBe(200);
      expect(response.body.path).toBe('/data/images/avatar.png');
      expect(characterService.setAvatar).toHaveBeenCalledWith('/data/images/avatar.png');
    });

    it('does NOT persist to the character when persistToCharacter is omitted', async () => {
      imageGen.generateAvatar.mockResolvedValue({
        generationId: 'gen-006',
        filename: 'avatar.png',
        path: '/data/images/avatar.png',
      });

      const response = await request(app)
        .post('/api/image-gen/avatar')
        .send({ name: 'Gandalf', characterClass: 'Wizard' });

      expect(response.status).toBe(200);
      expect(characterService.setAvatar).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/image-gen/upload', () => {
    it('saves uploaded bytes into the gallery and returns a /data/images path', async () => {
      imageGen.local.saveUploadedGalleryImage.mockResolvedValue({
        filename: 'upload-deadbeef.png',
        path: '/data/images/upload-deadbeef.png',
      });

      const response = await request(app)
        .post('/api/image-gen/upload')
        .send({ data: Buffer.from('fake-png-bytes').toString('base64') });

      expect(response.status).toBe(200);
      expect(response.body.path).toBe('/data/images/upload-deadbeef.png');
      // The service receives the raw base64 string (route doesn't pre-decode).
      expect(imageGen.local.saveUploadedGalleryImage).toHaveBeenCalledWith(
        Buffer.from('fake-png-bytes').toString('base64'),
      );
    });

    it('rejects a missing data field with 400', async () => {
      const response = await request(app)
        .post('/api/image-gen/upload')
        .send({});

      expect(response.status).toBe(400);
      expect(imageGen.local.saveUploadedGalleryImage).not.toHaveBeenCalled();
    });
  });

  // GET /:jobId/events and POST /cancel both go through the dispatcher's
  // attachSseClient/cancel — these tests lock in that contract so a future
  // refactor can't accidentally re-couple them to the local provider.
  describe('SSE attach + cancel via dispatcher', () => {
    it('GET /:jobId/events returns 404 when no provider owns the job', async () => {
      imageGen.attachSseClient.mockReturnValueOnce(false);
      const response = await request(app).get('/api/image-gen/missing-job/events');
      expect(response.status).toBe(404);
      expect(response.body.error).toMatch(/not found/i);
      expect(response.body.code).toBe('NOT_FOUND');
      expect(imageGen.attachSseClient).toHaveBeenCalledWith('missing-job', expect.anything());
    });

    it('POST /cancel returns ok=false when no provider had a job', async () => {
      imageGen.cancel.mockReturnValueOnce(false);
      const response = await request(app).post('/api/image-gen/cancel');
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(false);
      expect(imageGen.cancel).toHaveBeenCalled();
    });

    it('POST /cancel returns ok=true when a provider cancelled', async () => {
      imageGen.cancel.mockReturnValueOnce(true);
      const response = await request(app).post('/api/image-gen/cancel');
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });

    it('POST /cancel { all: true } cancels every queued/running image job', async () => {
      mediaJobQueue.listJobs.mockReturnValueOnce([
        { id: 'a', status: 'running' },
        { id: 'b', status: 'queued' },
        { id: 'c', status: 'queued' },
      ]);
      const response = await request(app).post('/api/image-gen/cancel').send({ all: true });
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.attempted).toBe(3);
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledTimes(3);
      // Queued jobs cancelled before the running one — slot doesn't refill mid-loop.
      expect(mediaJobQueue.cancelJob.mock.calls.map((c) => c[0])).toEqual(['b', 'c', 'a']);
      // Belt-and-braces: legacy single-process cancel also poked.
      expect(imageGen.cancel).toHaveBeenCalled();
    });

    it('POST /cancel (no jobId) picks the most-recently-submitted job by queuedAt — NOT the listJobs() ordering', async () => {
      // listJobs() returns jobs in queue-internal order: gpuRunning first,
      // then codexRunning, then queue. Without explicit queuedAt sorting, a
      // bare `/cancel` (the user's "stop the last thing I submitted" gesture)
      // would target the gpuRunning job — even when the user just queued a
      // newer Codex job that should be the cancel target. The route must
      // tie-break by queuedAt DESC so the newest submit always wins.
      mediaJobQueue.listJobs.mockReturnValueOnce([
        // listJobs ordering: gpu-running first (oldest submit, started long ago).
        { id: 'gpu-running', status: 'running', queuedAt: '2026-05-05T08:00:00Z' },
        // Codex job queued AFTER the GPU job started — this is the "most
        // recent submit" and should be the cancel target.
        { id: 'codex-newest', status: 'queued', queuedAt: '2026-05-05T08:30:00Z' },
        // Older queued job, should NOT be picked.
        { id: 'queued-older', status: 'queued', queuedAt: '2026-05-05T08:15:00Z' },
      ]);
      const response = await request(app).post('/api/image-gen/cancel').send({});
      expect(response.status).toBe(200);
      // The newest-submit (codex-newest at 08:30) wins — not 'gpu-running'
      // (which appeared first in listJobs) and not 'queued-older'.
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledTimes(1);
      expect(mediaJobQueue.cancelJob.mock.calls[0][0]).toBe('codex-newest');
    });

    it('POST /cancel (explicit jobId) cancels exactly that job and skips queuedAt selection', async () => {
      // When a jobId is provided, the route must cancel THAT job — even if a
      // newer queued job exists. This locks in that explicit selection wins
      // over the queuedAt fallback (writers-room "cancel this scene").
      mediaJobQueue.listJobs.mockReturnValueOnce([
        { id: 'newest', status: 'queued', queuedAt: '2026-05-05T08:30:00Z' },
        { id: 'middle', status: 'queued', queuedAt: '2026-05-05T08:20:00Z' },
        { id: 'oldest', status: 'running', queuedAt: '2026-05-05T08:00:00Z' },
      ]);
      const response = await request(app).post('/api/image-gen/cancel').send({ jobId: 'middle' });
      expect(response.status).toBe(200);
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledTimes(1);
      expect(mediaJobQueue.cancelJob.mock.calls[0][0]).toBe('middle');
    });
  });

  describe('GET /setup/check (cache behavior)', () => {
    // Each test uses a unique pythonPath so the module-scope cache from one
    // test doesn't bleed into the next (vi.clearAllMocks() resets call counts
    // but not the cache Map).
    let probePythonHealth, createVenv;
    beforeEach(async () => {
      const mod = await import('../lib/pythonSetup.js');
      probePythonHealth = mod.probePythonHealth;
      createVenv = mod.createVenv;
      mockStat.mockReset();
      mockStat.mockResolvedValue({ mtimeMs: 1_700_000_000_000 });
    });

    it('returns the same payload on a cache hit and only spawns python once', async () => {
      const p = '/usr/bin/python3-cache-hit-test';
      const r1 = await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(p)}`);
      const r2 = await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(p)}`);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r1.body).toEqual(r2.body);
      expect(probePythonHealth).toHaveBeenCalledTimes(1);
    });

    it('busts the cache when the python interpreter mtime changes', async () => {
      const p = '/usr/bin/python3-mtime-test';
      mockStat.mockResolvedValueOnce({ mtimeMs: 1_700_000_000_000 });
      await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(p)}`);
      mockStat.mockResolvedValueOnce({ mtimeMs: 1_700_000_000_001 });
      await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(p)}`);
      expect(probePythonHealth).toHaveBeenCalledTimes(2);
    });

    it('does not cache when stat fails (broken / missing path)', async () => {
      const p = '/usr/bin/python3-stat-fail-test';
      mockStat.mockRejectedValue(new Error('ENOENT'));
      await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(p)}`);
      await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(p)}`);
      expect(probePythonHealth).toHaveBeenCalledTimes(2);
    });

    it('cache for distinct pythonPaths are independent', async () => {
      const p1 = '/usr/bin/python3-distinct-a';
      const p2 = '/opt/homebrew/bin/python3-distinct-b';
      await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(p1)}`);
      await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(p2)}`);
      // Two distinct paths → two probe spawns; both then cached for repeats.
      expect(probePythonHealth).toHaveBeenCalledTimes(2);
      await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(p1)}`);
      expect(probePythonHealth).toHaveBeenCalledTimes(2);
    });

    it('POST /setup/create-venv invalidates the base AND new venv cache entries', async () => {
      const base = '/usr/bin/python3-venv-test';
      // Warm cache for the base python.
      await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(base)}`);
      expect(probePythonHealth).toHaveBeenCalledTimes(1);

      // Create venv (mocked to return /fake/venv/python).
      const created = await request(app).post('/api/image-gen/setup/create-venv').send({ basePython: base });
      expect(created.status).toBe(200);
      expect(createVenv).toHaveBeenCalled();

      // Next probe of the base python re-spawns (cache busted).
      await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(base)}`);
      expect(probePythonHealth).toHaveBeenCalledTimes(2);
    });

    it('GET /setup/install completion invalidates the cache for that pythonPath', async () => {
      const p = '/usr/bin/python3-install-bust-test';
      // Warm cache.
      await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(p)}`);
      expect(probePythonHealth).toHaveBeenCalledTimes(1);

      // Run install (mocked installPackages resolves immediately).
      const installRes = await request(app).get(`/api/image-gen/setup/install?pythonPath=${encodeURIComponent(p)}&packages=mflux`);
      expect(installRes.status).toBe(200);

      // The next /setup/check must re-probe — the install just changed the
      // missing-packages list, and the SSE consumer re-runs /setup/check on
      // `complete` expecting fresh data.
      await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(p)}`);
      expect(probePythonHealth).toHaveBeenCalledTimes(2);
    });

    it('write path sweeps expired entries so long-running processes do not accumulate', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const stale = '/usr/bin/python3-sweep-stale';
        const fresh = '/usr/bin/python3-sweep-fresh';
        // Warm the cache with one entry, then advance past the TTL.
        await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(stale)}`);
        vi.advanceTimersByTime(31_000);
        // A write for a different path triggers the sweep — stale entry drops.
        await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(fresh)}`);
        // A subsequent probe of the stale path re-spawns, confirming the entry
        // was actually removed (not merely TTL-bypassed).
        await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(stale)}`);
        // 3 spawns total: initial stale, fresh, post-sweep stale.
        expect(probePythonHealth).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('GET /setup/check (arch fields)', () => {
    // The route's archMismatch logic gates on `process.platform === 'darwin'` —
    // override it so the assertions run identically on Linux CI and a dev Mac.
    const originalPlatform = process.platform;
    let probePythonHealth, detectArm64Python;

    beforeEach(async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const mod = await import('../lib/pythonSetup.js');
      probePythonHealth = mod.probePythonHealth;
      detectArm64Python = mod.detectArm64Python;
      mockStat.mockReset();
      mockStat.mockResolvedValue({ mtimeMs: 1_700_000_000_000 });
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      hostArchHolder.value = 'arm64';
    });

    it('exposes hostArch + archMismatch + suggestedArm64Python on matched arch', async () => {
      const r = await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent('/arch-fields-match')}`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        hostArch: 'arm64',
        archMismatch: false,
        suggestedArm64Python: null,
        interpreterArch: 'arm64',
      });
    });

    it('flips archMismatch true and includes the suggested arm64 python on an x86_64 interpreter', async () => {
      probePythonHealth.mockResolvedValueOnce({
        installed: [], missing: [], missingPip: [],
        externallyManaged: false, interpreterArch: 'x86_64',
      });
      detectArm64Python.mockResolvedValueOnce('/opt/homebrew/bin/python3');
      const r = await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent('/arch-fields-x86')}`);
      expect(r.status).toBe(200);
      expect(r.body.archMismatch).toBe(true);
      expect(r.body.suggestedArm64Python).toBe('/opt/homebrew/bin/python3');
    });

    it('returns suggestedArm64Python null when no arm64 interpreter is available to suggest', async () => {
      probePythonHealth.mockResolvedValueOnce({
        installed: [], missing: [], missingPip: [],
        externallyManaged: false, interpreterArch: 'x86_64',
      });
      detectArm64Python.mockResolvedValueOnce(null);
      const r = await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent('/arch-fields-no-arm64')}`);
      expect(r.status).toBe(200);
      expect(r.body.archMismatch).toBe(true);
      expect(r.body.suggestedArm64Python).toBeNull();
    });

    it('does not flag archMismatch on non-darwin even when interpreter arch differs', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      probePythonHealth.mockResolvedValueOnce({
        installed: [], missing: [], missingPip: [],
        externallyManaged: false, interpreterArch: 'x86_64',
      });
      const r = await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent('/arch-fields-linux')}`);
      expect(r.status).toBe(200);
      expect(r.body.archMismatch).toBe(false);
      expect(r.body.suggestedArm64Python).toBeNull();
    });

    it('does not flag archMismatch on darwin/x86_64 hosts (Intel macs) — only arm64 hosts care about mlx wheels', async () => {
      hostArchHolder.value = 'x86_64';
      probePythonHealth.mockResolvedValueOnce({
        installed: [], missing: [], missingPip: [],
        externallyManaged: false, interpreterArch: 'x86_64',
      });
      const r = await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent('/arch-fields-intel-mac')}`);
      expect(r.status).toBe(200);
      expect(r.body.hostArch).toBe('x86_64');
      expect(r.body.archMismatch).toBe(false);
      expect(r.body.suggestedArm64Python).toBeNull();
      expect(detectArm64Python).not.toHaveBeenCalled();
    });
  });

  // SynthID-defeat regen (issue #912).
  describe('GET /api/image-gen/regen/availability', () => {
    it('reports the local FLUX backend as available when the venv is healthy', async () => {
      // isFlux2VenvHealthy is mocked to true and the real model registry
      // carries FLUX.2 models, so a flux-venv model resolves.
      const response = await request(app).get('/api/image-gen/regen/availability');
      expect(response.status).toBe(200);
      expect(response.body.available).toBe(true);
      expect(typeof response.body.modelId).toBe('string');
    });

    it('carries the strength slider bounds for the lightbox control', async () => {
      const response = await request(app).get('/api/image-gen/regen/availability');
      expect(typeof response.body.strengthMin).toBe('number');
      expect(typeof response.body.strengthMax).toBe('number');
      expect(typeof response.body.strengthDefault).toBe('number');
      // Floor is a small positive value (strength 0 is the degenerate
      // ignore-the-init-image case), and the default sits within the bounds.
      expect(response.body.strengthMin).toBeGreaterThan(0);
      expect(response.body.strengthDefault).toBeGreaterThanOrEqual(response.body.strengthMin);
      expect(response.body.strengthDefault).toBeLessThanOrEqual(response.body.strengthMax);
    });

    it('threads a named source image’s model into the availability pick so the reported model matches the regen (issue #2036)', async () => {
      const resolveGallerySpy = vi.spyOn(fileUtils, 'resolveGalleryImage')
        .mockReturnValueOnce('/fake/gallery/source.png');
      imageGen.local.readImageSidecar.mockResolvedValueOnce({
        path: '', metadata: { modelId: 'flux2-klein-9b' },
      });
      const availSpy = vi.spyOn(regen, 'getRegenAvailability')
        .mockResolvedValueOnce({ available: true, modelId: 'flux2-klein-9b', strengthMin: 0.02, strengthMax: 0.6, strengthDefault: 0.25 });

      // A path-prefixed query value must never reach the sidecar read raw — the
      // sidecar is read by the RESOLVED gallery path's basename (traversal-safe).
      const response = await request(app).get('/api/image-gen/regen/availability?filename=..%2F..%2Fsource.png');

      expect(response.status).toBe(200);
      expect(response.body.modelId).toBe('flux2-klein-9b');
      expect(imageGen.local.readImageSidecar).toHaveBeenCalledWith('source.png');
      // The source model must reach the availability resolver, or the dialog can
      // name a different model than the POST enqueues on a multi-model install.
      expect(availSpy).toHaveBeenCalledWith({ sourceModelId: 'flux2-klein-9b' });

      resolveGallerySpy.mockRestore();
      availSpy.mockRestore();
    });
  });

  describe('POST /api/image-gen/:filename/regenerate', () => {
    it('rejects an out-of-range strength before touching the filesystem (400)', async () => {
      const response = await request(app)
        .post('/api/image-gen/whatever.png/regenerate')
        .send({ strength: 0.95 }); // max is 0.6
      expect(response.status).toBe(400);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('404s when the source image is not in the gallery', async () => {
      const response = await request(app)
        .post('/api/image-gen/does-not-exist.png/regenerate')
        .send({});
      expect(response.status).toBe(404);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('enqueues a regen job and returns the queued response shape', async () => {
      // Arrange — stand in for the real filesystem and regen helpers.
      const resolveGallerySpy = vi.spyOn(fileUtils, 'resolveGalleryImage')
        .mockReturnValueOnce('/fake/gallery/source.png');
      imageGen.local.readImageSidecar.mockResolvedValueOnce({
        path: '/fake/gallery/source.png.json',
        metadata: { modelId: 'flux-dev', prompt: 'a robot' },
      });
      const readDimsSpy = vi.spyOn(regen, 'readImageDimensions')
        .mockResolvedValueOnce({ width: 1024, height: 1024 });
      const resolveBackendSpy = vi.spyOn(regen, 'resolveRegenBackend')
        .mockResolvedValueOnce({ available: true, model: { id: 'flux-dev' }, pythonPath: '/fake/venv/python' });
      const buildParamsSpy = vi.spyOn(regen, 'buildRegenParams')
        .mockReturnValueOnce({ kind: 'image', regenJob: true, filename: 'source.png' });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'regen-job-001', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/source.png/regenerate')
        .send({ strength: 0.25 });

      expect(response.status).toBe(200);
      // Response must carry the queuedImageResponse shape: jobId, generationId,
      // filename, path, mode, model, status, position.
      expect(response.body.jobId).toBe('regen-job-001');
      expect(response.body.generationId).toBe('regen-job-001');
      expect(response.body.filename).toBe('regen-job-001.png');
      expect(response.body.mode).toBe('local');
      expect(response.body.model).toBe('flux-dev');
      expect(response.body.status).toBe('queued');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledTimes(1);
      expect(buildParamsSpy).toHaveBeenCalledWith(expect.objectContaining({ strength: 0.25 }));

      resolveGallerySpy.mockRestore();
      readDimsSpy.mockRestore();
      resolveBackendSpy.mockRestore();
      buildParamsSpy.mockRestore();
    });

    // Annotation re-render (issue #2036 phase 2)
    it('400s an annotated re-render when no annotation has been saved', async () => {
      const resolveGallerySpy = vi.spyOn(fileUtils, 'resolveGalleryImage')
        .mockReturnValueOnce('/fake/gallery/source.png');
      const sketchPathSpy = vi.spyOn(mediaSketches, 'getSketchPngPath')
        .mockResolvedValueOnce(null);

      const response = await request(app)
        .post('/api/image-gen/source.png/regenerate')
        .send({ annotated: true });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('NO_ANNOTATION');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();

      resolveGallerySpy.mockRestore();
      sketchPathSpy.mockRestore();
    });

    it('400s an annotated re-render on the light method (init image needs the GPU pass)', async () => {
      const resolveGallerySpy = vi.spyOn(fileUtils, 'resolveGalleryImage')
        .mockReturnValueOnce('/fake/gallery/source.png');

      const response = await request(app)
        .post('/api/image-gen/source.png/regenerate')
        .send({ annotated: true, method: 'light' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();

      resolveGallerySpy.mockRestore();
    });

    it('stages the flattened annotation into an init-image root the runner accepts, at the higher default strength', async () => {
      // A real flattened-sketch file for the route to copy — the fix stages a
      // snapshot into PATHS.imageRefs, and the runner's resolveImageInputPath
      // must accept the staged path (media-sketches/ is NOT an approved root).
      const srcSketch = pathJoin(tmpdir(), `annot-src-${Date.now()}.png`);
      await writeFile(srcSketch, Buffer.from('89504e470d0a1a0a', 'hex'));

      const resolveGallerySpy = vi.spyOn(fileUtils, 'resolveGalleryImage')
        .mockReturnValueOnce('/fake/gallery/source.png');
      const sketchPathSpy = vi.spyOn(mediaSketches, 'getSketchPngPath')
        .mockResolvedValueOnce(srcSketch);
      imageGen.local.readImageSidecar.mockResolvedValueOnce({
        path: '/fake/gallery/source.png.json',
        metadata: { modelId: 'flux-dev', prompt: 'a robot' },
      });
      const readDimsSpy = vi.spyOn(regen, 'readImageDimensions')
        .mockResolvedValueOnce({ width: 1024, height: 1024 });
      const resolveBackendSpy = vi.spyOn(regen, 'resolveRegenBackend')
        .mockResolvedValueOnce({ available: true, model: { id: 'flux-dev' }, pythonPath: '/fake/venv/python' });
      // buildRegenParams is NOT mocked — assert the REAL params the route enqueues.
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'annot-job-001', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/source.png/regenerate')
        .send({ annotated: true }); // no explicit strength → annotated default

      expect(response.status).toBe(200);
      expect(response.body.jobId).toBe('annot-job-001');
      const [enqueued] = mediaJobQueue.enqueueJob.mock.calls;
      const params = enqueued[0].params;
      expect(params.annotatedRegen).toBe(true);
      expect(params.initImageStrength).toBe(regen.REGEN_ANNOTATED_STRENGTH_DEFAULT);
      // Regression guard for the silently-dropped-init-image bug: the staged
      // path must resolve under an approved image-input root, AND carry the
      // `init-<uuid>` name that imageRefsGc.js sweeps (so a canceled re-render
      // doesn't leak the snapshot).
      expect(params.initImagePath).toMatch(/[/\\]image-refs[/\\]init-[0-9a-f-]+\.png$/i);
      expect(fileUtils.resolveImageInputPath(params.initImagePath)).not.toBeNull();

      await rm(params.initImagePath, { force: true });
      await rm(srcSketch, { force: true });
      resolveGallerySpy.mockRestore();
      sketchPathSpy.mockRestore();
      readDimsSpy.mockRestore();
      resolveBackendSpy.mockRestore();
    });
  });
});
