vi.mock('../services/catalogDB/identityAccess.js', () => ({ assertCatalogIdentityWritable: vi.fn(async id => id) }));
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import { resolveImageCleaners } from '../lib/imageCleanDefaults.js';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { pinPlatform, request, startLoopbackServer, closeLoopbackServer } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// The annotated-regen path stages its init-image snapshot under PATHS.imageRefs
// (imageGen.js's `ensureDir(PATHS.imageRefs)` + init-<uuid>.png write). Without
// this redirect the suite wrote that snapshot into the developer's live data/
// tree on every run of the "stages the flattened annotation" case (#6176).
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-imagegen-') }));
// `fileUtils.js` re-exports pathSafety.js's resolvers (resolveGalleryImage,
// resolveImageInputPath, …), but those read PATHS from `paths.js` directly —
// the fileUtils.js mock above never touches that binding. Mirror the same
// temp root here too, so the runner's own re-validation of the staged init
// path (`fileUtils.resolveImageInputPath`) agrees with where the write above
// actually landed.
vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-imagegen-') }));
afterAll(cleanupTempDataRoots);

const disconnectLifecycle = vi.hoisted(() => ({ onDisconnect: vi.fn() }));
vi.mock('../lib/sseDownload.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    onClientDisconnect: (req, res, handler) => actual.onClientDisconnect(req, res, () => {
      disconnectLifecycle.onDisconnect();
      handler();
    }),
  };
});

import imageGenRoutes from './imageGen.js';
import * as fileUtils from '../lib/fileUtils.js';
import * as regen from '../services/imageGen/regen.js';
import * as mediaSketches from '../services/mediaSketches.js';
import { writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join as pathJoin } from 'path';

const attachNodeImage = vi.hoisted(() => vi.fn(async () => ({})));
const getLoom = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../services/fableLoom/records.js', () => ({ attachNodeImage, getLoom }));

const compiledVisual = vi.hoisted(() => ({
  version: 1, compilerVersion: '1.0.0', status: 'locked', assets: [], adapters: [], omitted: [], warnings: [],
}));
const compileFableLoomVisualRequest = vi.hoisted(() => vi.fn(async ({ authoredPrompt, authoredNegativePrompt }) => ({
  prompt: authoredPrompt,
  negativePrompt: authoredNegativePrompt || '',
  referenceImagePaths: [],
  referenceImageStrengths: [],
  loraFilenames: [],
  loraScales: [],
  visualConditioning: compiledVisual,
})));
const fableLoomImageCapabilities = vi.hoisted(() => vi.fn(() => ({ version: 1, kind: 'image' })));
vi.mock('../services/fableLoom/visualConditioning.js', () => ({
  compileFableLoomVisualRequest,
  fableLoomImageCapabilities,
  fableLoomAdapterDigest: (...args) => vi.importActual('../services/fableLoom/visualConditioning.js')
    .then(actual => actual.fableLoomAdapterDigest(...args)),
}));

vi.mock('../services/imageGen/index.js', () => ({
  checkConnection: vi.fn(),
  generateImage: vi.fn(),
  generateAvatar: vi.fn(),
  attachSseClient: vi.fn(() => false),
  cancel: vi.fn(() => false),
  cancelJob: vi.fn(() => false),
  IMAGE_GEN_MODE: { EXTERNAL: 'external', LOCAL: 'local', CODEX: 'codex', GROK: 'grok', AGY: 'agy', FAL: 'fal' },
  IMAGE_GEN_MODES: ['external', 'local', 'codex', 'grok', 'agy', 'fal'],
  CLOUD_IMAGE_GEN_MODES: ['codex', 'grok', 'agy'],
  resolveImageCleaners,
  local: {
    listImageModels: vi.fn(() => []),
    listLoraFilenames: vi.fn(async () => []),
    listGallery: vi.fn(async () => []),
    assertGalleryFilename: vi.fn(),
    readImageSidecar: vi.fn(async () => ({ path: '', metadata: {} })),
    saveUploadedGalleryImage: vi.fn(async () => ({ filename: 'upload-abcd1234.png', path: '/data/images/upload-abcd1234.png' })),
  },
}));

// Default to external mode in tests so /generate goes through the dispatcher.
// Local-mode tests below override the settings mock to flip into queue mode.
// Spread the real module (rather than replacing it outright) so `settingsEvents`
// stays a real EventEmitter — `authGate.js` (reached via imageGenSetup.js's
// `resolveSetupInterpreter`, #9015) subscribes to it at import time.
vi.mock('../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(async () => ({ imageGen: { mode: 'external' } })),
}));

// Route tests assert the historical local default (`dev`) and python setup
// errors, not host admission. Use a stable capable host so those assertions
// behave the same on macOS, Linux, and Windows runners.
vi.mock('../lib/systemCapabilities.js', async () => {
  const actual = await vi.importActual('../lib/systemCapabilities.js');
  return {
    ...actual,
    captureSystemCapabilities: vi.fn(() => ({
      version: actual.SYSTEM_CAPABILITIES_VERSION,
      platform: 'darwin',
      arch: 'arm64',
      appleSilicon: true,
      cpuCount: 8,
      totalMemoryGb: 128,
      cuda: {
        status: 'absent',
        gpus: [],
        maxVramGb: null,
        primaryComputeCap: null,
        error: null,
      },
    })),
  };
});

vi.mock('../services/mediaJobQueue/index.js', () => ({
  assertMediaQueueRoom: vi.fn(),
  enqueueJob: vi.fn(({ kind }) => ({ jobId: `mock-${kind}-job`, position: 1, status: 'queued' })),
  attachSseClient: vi.fn(() => false),
  cancelJob: vi.fn(async () => ({ ok: true, status: 'canceling' })),
  listJobs: vi.fn(() => []),
}));

const recordUserAction = vi.hoisted(() => vi.fn(async () => ({ id: 'evt' })));
vi.mock('../services/userActions.js', () => ({ recordUserAction }));
const remoteDelete = vi.hoisted(() => ({
  deleteMediaAnywhere: vi.fn(async () => ({ status: 'pending', pendingDelete: { peerId: 'rec-owner', queuedAt: '2026-01-01T00:00:00.000Z' }, peerName: 'Example Owner' })),
  cancelPendingDelete: vi.fn(async () => ({ ok: true, cancelled: true })),
}));
vi.mock('../services/mediaRemoteDelete.js', () => remoteDelete);
const mediaUsage = vi.hoisted(() => ({ assertMediaDeletable: vi.fn(async () => {}) }));
vi.mock('../services/mediaUsage.js', () => mediaUsage);

// The /generate route resolves an optional universeRun collection target via
// findOrCreateUniverseCollection. Mock it so the universeRun test asserts the
// tag-resolution wiring without touching real collection storage.
// The federated branch resolves the peer + capacity preflight through this
// helper; mock it so the route test asserts its own validation and enqueue
// wiring without standing up a peer registry.
const federatedPeerId = '00000000-0000-4000-8000-0000000000f1';
vi.mock('../services/federatedMedia/remoteSubmission.js', () => ({
  prepareRemoteMediaJob: vi.fn(async ({ peerId, kind, request, inputAssets }) => ({
    peer: { id: peerId },
    capability: { kind, engine: request.engine, modelId: request.modelId },
    remoteMedia: { wireVersion: 1, peerId, reconcile: false, cancelRequested: false, request, ...(inputAssets?.length ? { inputAssets } : {}) },
  })),
}));

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
const hostArchHolder = vi.hoisted(() => ({ value: 'arm64', appleSilicon: undefined }));

vi.mock('../lib/pythonSetup.js', () => ({
  REQUIRED_PACKAGES: ['mflux', 'mlx'],
  get HOST_ARCH() { return hostArchHolder.value; },
  // Undefined follows HOST_ARCH so existing arm64/Intel cases stay put.
  // Rosetta sets appleSilicon while HOST_ARCH stays x86_64.
  hostIsAppleSilicon: () => hostArchHolder.appleSilicon ?? hostArchHolder.value === 'arm64',
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
  isFlux2InstallSatisfied: vi.fn(async () => true),
}));

// Stat the python binary to key the cache. Override per-test for mtime
// changes; default to a stable mtime so the cache HIT path works.
const mockStat = vi.fn(async () => ({ mtimeMs: 1_700_000_000_000, isFile: () => false }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, stat: (path) => mockStat(path) };
});

import * as imageGen from '../services/imageGen/index.js';
import * as characterService from '../services/character.js';
import * as mediaJobQueue from '../services/mediaJobQueue/index.js';
import { getSettings } from '../services/settings.js';
// Asserted against the CONSTANT, never a literal copy of it: the shipped agy
// pin has to be re-pointed whenever Google retires an id, and a hard-coded
// expectation here turns that routine bump into a false failure.
import { AGY_IMAGEGEN_DEFAULT_MODEL } from '../lib/imageGenCapabilities.js';
import { findOrCreateUniverseCollection } from '../services/mediaCollections.js';
import { prepareRemoteMediaJob } from '../services/federatedMedia/remoteSubmission.js';

describe('Image Gen Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    // These requests run over a real loopback socket (`lib/testHelper.js`'s
    // fetch-based harness), so on a real password-free install they'd carry
    // host control via `requestHasHostControl` — this stands in for the
    // `authGate` middleware server/index.js mounts ahead of every route,
    // without dragging its settings/instance-identity dependencies into this
    // suite. `imageGenSetup.js`'s `/setup/*` routes need it (#9015) to reach
    // an interpreter path outside the caller's own allowlisted categories.
    app.use((req, _res, next) => {
      req.portosAuthContext = { enabled: false, authenticated: false, method: null };
      next();
    });
    app.use('/api/image-gen', imageGenRoutes);
    app.use(errorMiddleware);
    vi.clearAllMocks();
  });

  it('deletes an image on the machine that owns it and reports a pending delete as pending', async () => {
    const res = await request(app).delete('/api/image-gen/fox.png');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'pending', pendingDelete: { peerId: 'rec-owner', queuedAt: '2026-01-01T00:00:00.000Z' }, peerName: 'Example Owner' });
    expect(remoteDelete.deleteMediaAnywhere).toHaveBeenCalledWith('image', 'fox.png');
    const cancel = await request(app).post('/api/image-gen/fox.png/cancel-delete');
    expect(cancel.body).toEqual({ ok: true, cancelled: true });
    expect(remoteDelete.cancelPendingDelete).toHaveBeenCalledWith('image', 'fox.png');
  });

  it('refuses to delete an image records still use until the user forces it', async () => {
    const { ServerError } = await import('../lib/errorHandler.js');
    const usages = [{ source: 'music-video', label: 'Music video', id: 'mv-1', title: 'Example', role: 'Shot 1', href: '/music-video/mv-1/scene/s-1' }];
    mediaUsage.assertMediaDeletable.mockImplementation(async (key, { force }) => {
      if (!force) throw new ServerError('In use', { status: 409, code: 'MEDIA_IN_USE', context: { usages } });
    });
    const refused = await request(app).delete('/api/image-gen/fox.png');
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'MEDIA_IN_USE', context: { usages } });
    expect(remoteDelete.deleteMediaAnywhere).not.toHaveBeenCalled();
    const forced = await request(app).delete('/api/image-gen/fox.png?force=1');
    expect(forced.status).toBe(200);
    expect(mediaUsage.assertMediaDeletable).toHaveBeenLastCalledWith('image:fox.png', { force: true });
    expect(remoteDelete.deleteMediaAnywhere).toHaveBeenCalledWith('image', 'fox.png');
    mediaUsage.assertMediaDeletable.mockImplementation(async () => {});
  });

  it('binds quick-edit preview to provider defaults and persists the exact composition without changing authored text', async () => {
    await fileUtils.ensureDir(fileUtils.PATHS.images);
    await writeFile(pathJoin(fileUtils.PATHS.images, 'quick-edit-prompt.png'), 'reviewed bytes');
    const body = { prompt: '  Make the coat red.  ', quickEdit: true, referenceImageFiles: ['quick-edit-prompt.png'] };
    const settings = { imageGen: { mode: 'codex', codex: { enabled: true } } };
    getSettings.mockResolvedValue(settings);
    const preview = await request(app).post('/api/image-gen/prompt-preview').send({ ...body, reviewReference: true });
    expect(preview.status).toBe(200);
    expect(preview.body.sentPrompt).toContain('Edit the reference image:   Make the coat red.  . Keep everything else');
    expect(preview.body.promptAdditions.map(a => a.id)).toEqual(['quick-edit-prefix', 'quick-edit-preservation', 'agent-instructions']);
    const reviewed = { ...body, reviewedReferenceDigest: preview.body.reviewedReferenceDigest, reviewedPromptDigest: preview.body.reviewedPromptDigest };
    getSettings.mockResolvedValue({ imageGen: { ...settings.imageGen, codex: { enabled: true, model: 'changed-model' } } });
    const stale = await request(app).post('/api/image-gen/generate').send(reviewed);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('REVIEWED_PROMPT_CHANGED');
    expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    getSettings.mockResolvedValue(settings);
    const sent = await request(app).post('/api/image-gen/generate').send(reviewed);
    expect(sent.status).toBe(200);
    const params = mediaJobQueue.enqueueJob.mock.calls.at(-1)[0].params;
    expect(params.authoredPrompt).toBe(body.prompt);
    expect(params.sentPrompt).toBe(preview.body.sentPrompt);
    expect(params.promptAdditions).toEqual(preview.body.promptAdditions.slice(0, 2));
    getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
  });

  it('sends further references after the edited image and refuses one replaced after review', async () => {
    await fileUtils.ensureDir(fileUtils.PATHS.images);
    const extra = pathJoin(fileUtils.PATHS.images, 'quick-edit-place.png');
    await writeFile(pathJoin(fileUtils.PATHS.images, 'quick-edit-subject.png'), 'subject bytes');
    await writeFile(extra, 'place bytes');
    const body = { prompt: 'Put her in the rink from image 2', quickEdit: true, referenceImageFiles: ['quick-edit-subject.png', 'quick-edit-place.png'] };
    const settings = { imageGen: { mode: 'codex', codex: { enabled: true } } };
    getSettings.mockResolvedValue(settings);
    const preview = await request(app).post('/api/image-gen/prompt-preview').send({ ...body, reviewReference: true });
    expect(preview.status).toBe(200);
    expect(preview.body.sentPrompt).toContain('Edit the first reference image: Put her in the rink from image 2. Use the other reference images only as visual references for this change. Keep everything else');
    expect(preview.body.promptAdditions.map(a => a.id).slice(0, 3)).toEqual(['quick-edit-prefix', 'quick-edit-references', 'quick-edit-preservation']);
    expect(preview.body.referenceImages.map(r => r.source)).toEqual(['Input image 1 · Image to edit', 'Input image 2 · Visual reference']);
    expect(preview.body.reviewedReferenceImage).toContain(Buffer.from('subject bytes').toString('base64'));
    const reviewed = { ...body, reviewedReferenceDigest: preview.body.reviewedReferenceDigest, reviewedPromptDigest: preview.body.reviewedPromptDigest };
    const sent = await request(app).post('/api/image-gen/generate').send(reviewed);
    expect(sent.status).toBe(200);
    expect(mediaJobQueue.enqueueJob.mock.calls.at(-1)[0].params.referenceImagePaths.map(p => p.split(/[/\\]/).pop())).toEqual(['quick-edit-subject.png', 'quick-edit-place.png']);
    await writeFile(extra, 'replacement bytes');
    const stale = await request(app).post('/api/image-gen/generate').send(reviewed);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('REVIEWED_PROMPT_CHANGED');
    getSettings.mockResolvedValue({ imageGen: { mode: 'agy', agy: { enabled: true } } });
    const files = ['a', 'b', 'c', 'd'].map(name => `quick-edit-many-${name}.png`);
    for (const file of files) await writeFile(pathJoin(fileUtils.PATHS.images, file), file);
    const over = await request(app).post('/api/image-gen/prompt-preview').send({ ...body, referenceImageFiles: files, reviewReference: true });
    expect(over.status).toBe(400);
    expect(over.body.code).toBe('TOO_MANY_INPUT_IMAGES');
    getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
  });

  it('refuses complete quick-edit prompts over the limit with a count before queue admission', async () => {
    await fileUtils.ensureDir(fileUtils.PATHS.images);
    await writeFile(pathJoin(fileUtils.PATHS.images, 'quick-edit-limit.png'), 'reviewed bytes');
    getSettings.mockResolvedValueOnce({ imageGen: { mode: 'codex', codex: { enabled: true } } });
    const response = await request(app).post('/api/image-gen/prompt-preview').send({
      prompt: 'x'.repeat(31999), quickEdit: true, referenceImageFiles: ['quick-edit-limit.png'], reviewReference: true,
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/\d+\/32000 characters/);
    expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
  });

  it('rejects a reference replaced after preview before admitting a quick edit', async () => {
    await fileUtils.ensureDir(fileUtils.PATHS.images);
    const path = pathJoin(fileUtils.PATHS.images, 'quick-edit-reviewed.png');
    await writeFile(path, 'reviewed bytes');
    const body = { prompt: 'Change the coat', mode: 'codex', referenceImageFiles: ['quick-edit-reviewed.png'] };
    const settings = { imageGen: { mode: 'codex', codex: { enabled: true } } };
    getSettings.mockResolvedValueOnce(settings);
    const preview = await request(app).post('/api/image-gen/prompt-preview').send({ ...body, reviewReference: true });
    expect(preview.status).toBe(200);
    expect(preview.body.reviewedReferenceImage).toContain(Buffer.from('reviewed bytes').toString('base64'));
    await writeFile(path, 'replacement bytes');
    getSettings.mockResolvedValueOnce(settings);
    const response = await request(app).post('/api/image-gen/generate').send({ ...body, reviewedReferenceDigest: preview.body.reviewedReferenceDigest });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('REVIEWED_REFERENCE_CHANGED');
    expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    expect(imageGen.generateImage).not.toHaveBeenCalled();
  });

  describe('GET /api/image-gen/gallery', () => {
    it('preserves legacy arrays and pages/searches the test disk fallback', async () => {
      const items = [
        { filename: 'a.png', prompt: 'red fox', path: '/data/images/a.png', seed: 42 },
        { filename: 'b.png', prompt: 'red fox', path: '/data/images/b.png' },
        { filename: 'c.png', prompt: 'blue fox', hidden: true },
      ];
      imageGen.local.listGallery.mockResolvedValue(items);
      expect((await request(app).get('/api/image-gen/gallery')).body).toEqual(items);
      const page = await request(app).get('/api/image-gen/gallery?limit=1&offset=1&q=red&hidden=false');
      expect(page.status).toBe(200);
      expect(page.body).toEqual({ items: [items[1]], total: 2, limit: 1, offset: 1 });
      const summary = await request(app).get('/api/image-gen/gallery?limit=5&hidden=false&summary=true');
      expect(summary.body).toEqual({ items: items.slice(0, 2), total: 2, hiddenTotal: 1, limit: 5, offset: 0 });
      const preview = await request(app).get('/api/image-gen/gallery?limit=1&filename=c.png');
      expect(preview.body).toEqual({ items: [items[2]], total: 1, limit: 1, offset: 0 });
      const empty = await request(app).get('/api/image-gen/gallery?q=missing');
      expect(empty.body).toEqual({ items: [], total: 0, limit: 60, offset: 0 });
    });

    // #8292: migrated consumers opt into compact card rows; search and visible
    // counts still read the full stored metadata, and older callers keep full records.
    it('projects compact visible rows on request while searching the full prompt', async () => {
      const longPrompt = 'harbor at dawn '.repeat(60) + 'lighthouse';
      const items = [
        { filename: 'a.png', prompt: longPrompt, negativePrompt: 'blur '.repeat(200), path: '/data/images/a.png', seed: 3, width: 64, height: 64, cfgScale: 4, cleanedFrom: 'root.png' },
        { filename: 'b.png', prompt: 'short', hidden: true },
      ];
      imageGen.local.listGallery.mockResolvedValue(items);
      const compact = await request(app).get('/api/image-gen/gallery?limit=5&hidden=false&summary=true&compact=true&q=lighthouse');
      expect(compact.status).toBe(200);
      expect(compact.body).toMatchObject({ total: 1, hiddenTotal: 0 });
      const [row] = compact.body.items;
      expect(row).toMatchObject({ compact: true, filename: 'a.png', path: '/data/images/a.png', seed: 3, width: 64, cleanedFrom: 'root.png' });
      expect(row.prompt.length).toBeLessThanOrEqual(241);
      expect(longPrompt.startsWith(row.prompt.slice(0, -1))).toBe(true);
      expect(row).not.toHaveProperty('negativePrompt');
      expect(row).not.toHaveProperty('cfgScale');
      const visible = await request(app).get('/api/image-gen/gallery?limit=5&hidden=false&summary=true&compact=true');
      expect(visible.body).toMatchObject({ total: 1, hiddenTotal: 1 });
      const full = await request(app).get('/api/image-gen/gallery?limit=5&hidden=false');
      expect(full.body.items).toEqual([items[0]]);
      expect((await request(app).get('/api/image-gen/gallery?compact=yes')).status).toBe(400);
    });

    it('hydrates only requested filenames and rejects an oversized reference batch', async () => {
      const items = [{ filename: 'a.png', prompt: 'first' }, { filename: 'b.png', prompt: 'second' }];
      imageGen.local.listGallery.mockResolvedValue(items);
      const response = await request(app).post('/api/image-gen/gallery/lookup').send({ filenames: ['b.png'] });
      expect(response.status).toBe(200);
      expect(response.body).toEqual([items[1]]);
      const oversized = await request(app).post('/api/image-gen/gallery/lookup').send({ filenames: Array.from({ length: 201 }, (_, n) => `${n}.png`) });
      expect(oversized.status).toBe(400);
    });

    it.each(['limit=0', 'limit=201', 'offset=-1', 'limit=1.5', 'q=a&q=b', 'starred=1', 'summary=yes', 'filename='])('rejects invalid paging: %s', async query => {
      const response = await request(app).get('/api/image-gen/gallery?' + query);
      expect(response.status).toBe(400);
      expect(imageGen.local.listGallery).not.toHaveBeenCalled();
    });
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

    it('forwards a bounded local model selection into checkConnection', async () => {
      imageGen.checkConnection.mockResolvedValue({ connected: true, mode: 'local', modelId: 'flux2-klein-4b' });
      const response = await request(app).get('/api/image-gen/status?mode=local&modelId=flux2-klein-4b');
      expect(response.status).toBe(200);
      expect(imageGen.checkConnection).toHaveBeenCalledWith({ mode: 'local', modelId: 'flux2-klein-4b' });
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

  describe('FableLoom preview/send parity with the real compiler', () => {
    const defaultCompile = compileFableLoomVisualRequest.getMockImplementation();
    const defaultCapabilities = fableLoomImageCapabilities.getMockImplementation();
    let canonLoom, canonUniverse, canonSeries, canonLoras;
    beforeEach(async () => {
      const { naturalUniverseVisualProfile } = await import('../lib/universeVisualProfile.js');
      canonUniverse = {
        id: 'example-universe', visualProfile: naturalUniverseVisualProfile(),
        characters: [{
          id: 'example-character', name: 'Example Scout', physicalDescription: 'a red coat',
          identityPack: { assets: ['neutral', 'profile', 'full-body'].map(role => ({
            role, imageRef: `example-${role}.png`, approved: true,
          })), avoid: ['wrong face'] },
        }],
        places: [{ id: 'example-place', name: 'Example Hall', primaryImageRef: 'example-hall.png' }],
        objects: [],
      };
      canonLoom = {
        id: 'example-loom', universeId: canonUniverse.id, seriesId: 'example-series',
        episodes: [{ id: 'ep-1', number: 1, startNodeId: 'node-1', nodes: [{
          id: 'node-1', imagePrompt: 'The scout arrives', transitions: [],
          visualCanon: { mode: 'locked', characterAppearances: [{ characterId: 'example-character' }], placeId: 'example-place' },
        }] }],
      };
      canonSeries = null;
      canonLoras = [];
      getLoom.mockImplementation(async () => canonLoom);
      const real = await vi.importActual('../services/fableLoom/visualConditioning.js');
      fableLoomImageCapabilities.mockImplementation(real.fableLoomImageCapabilities);
      compileFableLoomVisualRequest.mockImplementation(args => real.compileFableLoomVisualRequest({
        ...args, loadLoom: async () => canonLoom, loadUniverse: async () => canonUniverse,
        loadSeries: async () => canonSeries, resolveLoras: async () => canonLoras,
      }));
      await fileUtils.ensureDir(fileUtils.PATHS.images);
      for (const name of ['neutral', 'profile', 'full-body', 'hall']) {
        await writeFile(pathJoin(fileUtils.PATHS.images, `example-${name}.png`), 'synthetic image fixture');
      }
    });
    afterEach(() => {
      compileFableLoomVisualRequest.mockImplementation(defaultCompile);
      fableLoomImageCapabilities.mockImplementation(defaultCapabilities);
      getLoom.mockImplementation(async () => null);
    });

    // Catches drift in text, profile ownership, and ordered canon attachments at the HTTP boundary.
    it.each([
      ['local', 'inherited'], ['codex', 'inherited-init'], ['codex', 'custom'], ['local', 'disabled'],
      ['codex', 'series-override'], ['local', 'series-append'],
    ])('previews exactly the %s render with %s photography', async (mode, profileCase) => {
      const { codexSentPrompt } = await import('../services/imageGen/codex.js');
      const { localSentPrompt } = await import('../services/imageGen/local.js');
      const { resolveInputImages } = await import('../services/imageGen/inputImages.js');
      const { naturalUniverseVisualProfile } = await import('../lib/universeVisualProfile.js');
      const { getImageModels } = await import('../lib/mediaModels.js');
      const body = {
        prompt: 'The scout arrives', negativePrompt: 'blur', mode,
        ...(mode === 'local' ? { modelId: 'flux2-klein-9b' } : {}),
        fableLoom: { loomId: canonLoom.id, episodeId: 'ep-1', nodeId: 'node-1' },
      };
      if (profileCase === 'inherited-init') body.initImageFile = 'example-hall.png';
      let expectedProfile = canonUniverse.visualProfile;
      if (profileCase === 'custom') {
        body.visualProfileOverride = naturalUniverseVisualProfile();
        body.visualProfileOverride.generation.lighting = 'Custom amber lantern light';
        expectedProfile = body.visualProfileOverride;
      }
      if (profileCase === 'disabled') expectedProfile = body.visualProfileOverride = null;
      if (profileCase.startsWith('series-')) {
        canonSeries = { stylePromptOverride: 'woodcut lines', stylePromptOverrideMode: profileCase.slice(7) };
        if (profileCase === 'series-override') expectedProfile = null;
      }
      getSettings.mockResolvedValueOnce({ imageGen: { mode, local: { modelId: 'flux2-klein-9b' }, codex: { enabled: true } } });
      const preview = await request(app).post('/api/image-gen/prompt-preview').send(body);
      expect(preview.status).toBe(200);
      expect(preview.body.authoredPrompt).toBe(body.prompt);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(mediaJobQueue.assertMediaQueueRoom).not.toHaveBeenCalled();
      expect(imageGen.generateImage).not.toHaveBeenCalled();

      getSettings.mockResolvedValueOnce({ imageGen: { mode, local: { modelId: 'flux2-klein-9b' }, codex: { enabled: true } } });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'example-job', status: 'queued' });
      const submit = await request(app).post('/api/image-gen/generate').send(body);
      expect(submit.status).toBe(200);
      const params = mediaJobQueue.enqueueJob.mock.calls.at(-1)[0].params;
      const sent = mode === 'local'
        ? await localSentPrompt({ ...params, model: getImageModels().find(model => model.id === params.modelId) })
        : codexSentPrompt({ ...params, inputImages: resolveInputImages({ mode, ...params }) }).record;
      expect(preview.body.sentPrompt).toBe(sent.sentPrompt);
      expect(preview.body.sentNegativePrompt).toBe(sent.sentNegativePrompt);
      expect(preview.body.promptAdditions).toEqual(sent.promptAdditions);
      expect(preview.body.referenceImages.map(item => item.filename)).toEqual([...(params.initImagePath ? [params.initImagePath] : []), ...params.referenceImagePaths].map(path => basename(path)));
      expect(params.authoredPrompt).toBe(body.prompt);
      expect(params.visualProfile ?? null).toEqual(expectedProfile);
      for (const field of ['lighting', 'optics', 'materials']) {
        const text = expectedProfile?.generation[field];
        if (text) expect(params.prompt.split(text)).toHaveLength(2);
      }
      if (!expectedProfile) expect(params.prompt).not.toContain(canonUniverse.visualProfile.generation.lighting);
    });

    it('preserves authored references and adapters in the preview and queued request', async () => {
      canonLoom.episodes[0].nodes[0].visualCanon.placeId = null;
      await fileUtils.ensureDir(fileUtils.PATHS.loras);
      await writeFile(pathJoin(fileUtils.PATHS.images, 'example-request.png'), 'synthetic image fixture');
      await writeFile(pathJoin(fileUtils.PATHS.loras, 'example-one.safetensors'), 'synthetic adapter');
      await writeFile(pathJoin(fileUtils.PATHS.loras, 'example-one.safetensors.metadata.json'), JSON.stringify({ triggerWords: ['LOOM_TOKEN'] }));
      await writeFile(pathJoin(fileUtils.PATHS.loras, 'example-two.safetensors'), 'synthetic adapter');
      await writeFile(pathJoin(fileUtils.PATHS.loras, 'example-canon.safetensors'), 'synthetic canon adapter');
      canonLoras = [{ filename: 'example-canon.safetensors', scale: 0.75, character: { entryId: 'example-character' } }];
      const body = {
        prompt: 'The scout arrives', mode: 'local', modelId: 'flux2-klein-9b-bf16',
        fableLoom: { loomId: canonLoom.id, episodeId: 'ep-1', nodeId: 'node-1' },
        referenceImageFiles: ['example-request.png'], referenceStrengths: [0.4],
        loraFilenames: ['example-one.safetensors'],
        loraPaths: [pathJoin(fileUtils.PATHS.loras, 'example-two.safetensors')], loraScales: [0.65, 0.35],
      };
      const settings = { imageGen: { mode: 'local', local: { modelId: body.modelId } } };
      getSettings.mockResolvedValueOnce(settings);
      const preview = await request(app).post('/api/image-gen/prompt-preview').send(body);
      getSettings.mockResolvedValueOnce(settings);
      const submit = await request(app).post('/api/image-gen/generate').send(body);
      expect([preview.status, submit.status]).toEqual([200, 200]);
      const params = mediaJobQueue.enqueueJob.mock.calls.at(-1)[0].params;
      expect(params.referenceImagePaths.map(path => basename(path))).toEqual([
        'example-neutral.png', 'example-profile.png', 'example-full-body.png', 'example-request.png',
      ]);
      expect(params.referenceImageStrengths).toEqual([1, 1, 1, 0.4]);
      expect(params.loraFilenames).toEqual(['example-canon.safetensors', ...body.loraFilenames]);
      expect(params.loraPaths).toEqual(body.loraPaths);
      expect(params.loraScales).toEqual([0.75, ...body.loraScales]);
      expect(preview.body.sentPrompt).toContain('LOOM_TOKEN');
      expect(params.visualConditioning.renderedPrompt).toBe(preview.body.sentPrompt);
      expect(params.visualConditioning.adapters.map(adapter => adapter.sha256)).toEqual([
        'synthetic canon adapter', 'synthetic adapter', 'synthetic adapter',
      ].map(contents => createHash('sha256').update(contents).digest('hex')));
      expect(preview.body.referenceImages.map(item => item.filename)).toEqual(params.referenceImagePaths.map(path => basename(path)));
      expect(preview.body.referenceImages.at(-1)).toMatchObject({ source: 'Request reference', strength: 0.4 });
      expect(preview.body.loraAdapters).toEqual([
        { filename: 'example-canon.safetensors', scale: 0.75, source: 'Canon adapter' },
        { filename: 'example-one.safetensors', scale: 0.65, source: 'Request adapter' },
        { filename: 'example-two.safetensors', scale: 0.35, source: 'Request adapter' },
      ]);
    });

    it('keeps the Qwen backend reference capacity for an authored draft', async () => {
      canonLoom.episodes[0].nodes[0].visualCanon.mode = 'draft';
      const references = Array.from({ length: 5 }, (_, index) => `example-user-${index}.png`);
      await Promise.all(references.map(name => writeFile(pathJoin(fileUtils.PATHS.images, name), 'synthetic image fixture')));
      const body = { prompt: 'The scout arrives', mode: 'local', modelId: 'qwen-image-2.1', referenceImageFiles: references,
        fableLoom: { loomId: canonLoom.id, episodeId: 'ep-1', nodeId: 'node-1' } };
      const settings = { imageGen: { mode: 'local', local: { modelId: body.modelId } } };
      getSettings.mockResolvedValueOnce(settings);
      const preview = await request(app).post('/api/image-gen/prompt-preview').send(body);
      getSettings.mockResolvedValueOnce(settings);
      const submit = await request(app).post('/api/image-gen/generate').send(body);
      expect([preview.status, submit.status]).toEqual([200, 200]);
      const params = mediaJobQueue.enqueueJob.mock.calls.at(-1)[0].params;
      expect(params.referenceImagePaths.map(path => basename(path))).toEqual(references);
      expect(preview.body.referenceImages.map(item => item.filename)).toEqual(references);
    });

    it.each(['fal'])('retains more than four authored references on %s', async mode => {
      const references = Array.from({ length: 5 }, (_, index) => `example-cloud-${index}.png`);
      await Promise.all(references.map(name => writeFile(pathJoin(fileUtils.PATHS.images, name), 'synthetic image fixture')));
      const body = { prompt: 'The scout arrives', mode, referenceImageFiles: references,
        fableLoom: { loomId: canonLoom.id, episodeId: 'ep-1', nodeId: 'node-1' } };
      const settings = { imageGen: { mode, [mode]: { enabled: true } } };
      getSettings.mockResolvedValueOnce(settings);
      const preview = await request(app).post('/api/image-gen/prompt-preview').send(body);
      getSettings.mockResolvedValueOnce(settings);
      const submit = await request(app).post('/api/image-gen/generate').send(body);
      expect([preview.status, submit.status]).toEqual([200, 200]);
      const params = mediaJobQueue.enqueueJob.mock.calls.at(-1)[0].params;
      expect(params.referenceImagePaths.slice(-5).map(path => basename(path))).toEqual(references);
      expect(preview.body.referenceImages.map(item => item.filename)).toEqual(params.referenceImagePaths.map(path => basename(path)));
      expect(params.referenceImagePaths).toHaveLength(9);
    });

    it.each([
      ['reference budget', 'agy', { referenceImageFiles: ['example-hall.png'] }, 'FABLELOOM_INPUT_BUDGET_EXCEEDED'],
      ['unsupported adapter', 'codex', { loraFilenames: ['example.safetensors'] }, 'FABLELOOM_LORA_UNSUPPORTED'],
      ['quantized adapter and references', 'local', { modelId: 'flux2-klein-9b', loraFilenames: ['example.safetensors'] }, 'FABLELOOM_INPUTS_INCOMPATIBLE'],
      ['adapter budget', 'local', { modelId: 'flux2-klein-9b-bf16', loraFilenames: Array.from({ length: 8 }, (_, i) => `example-${i}.safetensors`), loraPaths: ['/example/other.safetensors'] }, 'FABLELOOM_LORA_BUDGET_EXCEEDED'],
      ['missing adapter', 'local', { modelId: 'flux2-klein-9b-bf16', loraFilenames: ['missing-example.safetensors'] }, 'FABLELOOM_LORA_NOT_FOUND'],
      ['duplicate adapter', 'local', { modelId: 'flux2-klein-9b-bf16', loraFilenames: ['example.safetensors'] }, 'FABLELOOM_LORA_DUPLICATE'],
      ['orphan adapter scale', 'local', { modelId: 'flux2-klein-9b-bf16', loraScales: [0.5] }, 'FABLELOOM_LORA_SCALE_MISMATCH'],
      ['unsupported reference strength', 'codex', { referenceImageFiles: ['example-hall.png'], referenceStrengths: [0.4] }, 'FABLELOOM_REFERENCE_STRENGTH_UNSUPPORTED'],
      ['orphan reference strength', 'codex', { referenceStrengths: [0.4] }, 'FABLELOOM_REFERENCE_STRENGTH_MISMATCH'],
    ])('refuses %s in both preview and submission without queueing', async (_label, mode, extra, code) => {
      await fileUtils.ensureDir(fileUtils.PATHS.loras);
      await writeFile(pathJoin(fileUtils.PATHS.loras, 'example.safetensors'), 'synthetic adapter');
      if (_label === 'duplicate adapter') canonLoras = [{ filename: 'example.safetensors', scale: 0.75, character: { entryId: 'example-character' } }];
      if (_label === 'unsupported reference strength') canonLoom.episodes[0].nodes[0].visualCanon.placeId = null;
      const body = { prompt: 'The scout arrives', mode, ...extra,
        fableLoom: { loomId: canonLoom.id, episodeId: 'ep-1', nodeId: 'node-1' } };
      const settings = { imageGen: { mode, local: { modelId: body.modelId }, codex: { enabled: true }, agy: { enabled: true } } };
      getSettings.mockResolvedValueOnce(settings);
      const preview = await request(app).post('/api/image-gen/prompt-preview').send(body);
      getSettings.mockResolvedValueOnce(settings);
      const submit = await request(app).post('/api/image-gen/generate').send(body);
      expect([preview.status, preview.body.code, preview.body.error]).toEqual([submit.status, submit.body.code, submit.body.error]);
      expect(preview.status).toBe(400);
      expect(preview.body.code).toBe(code);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('refuses unrecordable canon adapter evidence in preview and submission', async () => {
      canonLoom.episodes[0].nodes[0].visualCanon.placeId = null;
      await fileUtils.ensureDir(fileUtils.PATHS.loras);
      await writeFile(pathJoin(fileUtils.PATHS.loras, 'example-canon.safetensors'), 'synthetic canon adapter');
      canonLoras = [{ filename: 'example-canon.safetensors', scale: 3, character: { entryId: 'example-character' } }];
      const body = {
        mode: 'local', modelId: 'flux2-klein-9b-bf16', prompt: 'The scout arrives',
        fableLoom: { loomId: canonLoom.id, episodeId: 'ep-1', nodeId: 'node-1' },
      };
      const localSettings = { imageGen: { mode: 'local', local: { modelId: body.modelId } } };
      getSettings.mockResolvedValueOnce(localSettings);
      const preview = await request(app).post('/api/image-gen/prompt-preview').send(body);
      getSettings.mockResolvedValueOnce(localSettings);
      const submit = await request(app).post('/api/image-gen/generate').send(body);
      expect([preview.status, preview.body.code]).toEqual([400, 'FABLELOOM_PROVENANCE_UNAVAILABLE']);
      expect([submit.status, submit.body.code, submit.body.error]).toEqual([preview.status, preview.body.code, preview.body.error]);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it.each([
      ['Windows mflux', 'win32', 'dev'], ['MOSS', 'darwin', 'moss-image-sft-bf16'],
    ])('refuses an init image on %s in preview and submission before queueing', async (_label, platform, modelId) => {
      const restore = pinPlatform(platform);
      try {
        canonLoom.episodes[0].nodes[0].visualCanon = { mode: 'locked', characterAppearances: [], placeId: null, objectIds: [] };
        const body = {
          mode: 'local', modelId, prompt: 'An authored view', initImageFile: 'example-hall.png',
          fableLoom: { loomId: canonLoom.id, episodeId: 'ep-1', nodeId: 'node-1' },
        };
        const localSettings = { imageGen: { mode: 'local', local: { modelId, pythonPath: '/example/python' } } };
        getSettings.mockResolvedValueOnce(localSettings);
        const preview = await request(app).post('/api/image-gen/prompt-preview').send(body);
        getSettings.mockResolvedValueOnce(localSettings);
        const submit = await request(app).post('/api/image-gen/generate').send(body);
        expect(preview.status).toBe(400);
        expect(preview.body.code).toBe('FABLELOOM_INIT_UNSUPPORTED');
        expect([submit.status, submit.body.code, submit.body.error]).toEqual([preview.status, preview.body.code, preview.body.error]);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      } finally { restore(); }
    });

    it.each(['missing-universe', 'missing-binding', 'unsupported-backend', 'disabled-provider'])('matches the %s refusal without provider work', async failure => {
      if (failure === 'missing-universe') canonUniverse = null;
      if (failure === 'missing-binding') canonLoom.episodes[0].nodes[0].visualCanon.placeId = 'missing-place';
      const body = {
        mode: failure === 'unsupported-backend' ? 'external' : 'codex',
        prompt: 'The scout arrives',
        fableLoom: { loomId: canonLoom.id, episodeId: 'ep-1', nodeId: 'node-1' },
      };
      const settings = { imageGen: { mode: body.mode, codex: { enabled: failure !== 'disabled-provider' } } };
      getSettings.mockResolvedValueOnce(settings);
      const preview = await request(app).post('/api/image-gen/prompt-preview').send(body);
      getSettings.mockResolvedValueOnce(settings);
      const submit = await request(app).post('/api/image-gen/generate').send(body);
      expect(preview.status).toBeGreaterThanOrEqual(400);
      expect([preview.status, preview.body.code, preview.body.error]).toEqual([submit.status, submit.body.code, submit.body.error]);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(imageGen.generateImage).not.toHaveBeenCalled();
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

    it('durably attaches a synchronous FableLoom scene render', async () => {
      getLoom.mockResolvedValueOnce({
        id: 'loom-1',
        renderSettings: { formatId: 'landscape-16-9' },
        episodes: [{ id: 'ep-1', number: 1, startNodeId: 'node-1', nodes: [{ id: 'node-1', transitions: [] }] }],
      });
      imageGen.generateImage.mockResolvedValue({
        generationId: 'gen-scene-001',
        filename: 'scene.png',
        path: '/data/images/scene.png',
      });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({
          prompt: 'an example scene',
          fableLoom: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' },
        });

      expect(response.status).toBe(200);
      expect(attachNodeImage).toHaveBeenCalledWith(
        'loom-1',
        'ep-1',
        'node-1',
        {
          filename: 'scene.png',
          jobId: 'gen-scene-001',
          visualConditioning: expect.objectContaining({
            render: expect.objectContaining({
              parameters: { width: 1024, height: 576, aspectRatio: '16:9' },
            }),
          }),
        },
      );
      expect(imageGen.generateImage).toHaveBeenCalledWith(expect.objectContaining({
        width: 1024, height: 576, aspectRatio: '16:9',
      }));
      expect(compileFableLoomVisualRequest).toHaveBeenCalledWith(expect.objectContaining({
        tag: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' }, kind: 'image',
      }));
    });

    it('preserves an explicit profile for an unlinked legacy FableLoom scene', async () => {
      const { naturalUniverseVisualProfile } = await import('../lib/universeVisualProfile.js');
      const profile = naturalUniverseVisualProfile();
      profile.finishing.mode = 'save';
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { modelId: 'flux2-klein-9b' } } });
      compileFableLoomVisualRequest.mockResolvedValueOnce(null);
      const response = await request(app).post('/api/image-gen/generate').send({
        prompt: 'An authored scene', visualProfileOverride: profile,
        fableLoom: { loomId: 'loom-legacy', episodeId: 'ep-1', nodeId: 'node-1' },
      });
      expect(response.status).toBe(200);
      const params = mediaJobQueue.enqueueJob.mock.calls.at(-1)[0].params;
      expect(params.visualProfile).toEqual(profile);
      expect(params.prompt.split(profile.generation.lighting)).toHaveLength(2);
      expect(params.prompt.startsWith('An authored scene')).toBe(true);
    });

    // The install pin used to be read only inside resolveLocalImageModel, so a
    // FableLoom generate with no body modelId compiled capability from `dev`
    // and then queued the pinned FLUX.2 model — stripping refs/LoRAs that the
    // actual runner would have accepted (#7362).
    it('threads the install-local pin through FableLoom capability compile and the queued job', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'local', local: { modelId: 'flux2-klein-9b' } },
      });
      getLoom.mockResolvedValueOnce({
        id: 'loom-1',
        renderSettings: { formatId: 'landscape-16-9' },
        episodes: [{ id: 'ep-1', number: 1, startNodeId: 'node-1', nodes: [{ id: 'node-1', transitions: [] }] }],
      });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-pin-001', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({
          prompt: 'an example scene',
          fableLoom: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' },
        });

      expect(response.status).toBe(200);
      expect(response.body.model).toBe('flux2-klein-9b');
      expect(fableLoomImageCapabilities).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'local',
        model: expect.objectContaining({ id: 'flux2-klein-9b' }),
      }));
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'image',
        params: expect.objectContaining({ modelId: 'flux2-klein-9b' }),
      }));
    });

    it('refuses a scene image in a later episode until prior storyboard images exist', async () => {
      getLoom.mockResolvedValueOnce({
        id: 'loom-1',
        episodes: [
          {
            id: 'ep-1',
            number: 1,
            startNodeId: 'scene-1',
            nodes: [{ id: 'scene-1', title: 'Prior scene', image: null, transitions: [] }],
          },
          {
            id: 'ep-2',
            number: 2,
            startNodeId: 'scene-2',
            nodes: [{ id: 'scene-2', title: 'Later scene', transitions: [] }],
          },
        ],
      });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({
          prompt: 'a later episode scene',
          fableLoom: { loomId: 'loom-1', episodeId: 'ep-2', nodeId: 'scene-2' },
        });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('FABLELOOM_EPISODE_ORDER_BLOCKED');
      expect(response.body.error).toContain('Finish storyboard images for Episode 1');
      expect(imageGen.generateImage).not.toHaveBeenCalled();
      expect(compileFableLoomVisualRequest).not.toHaveBeenCalled();
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

    it('rejects a NUL character in the prompt or negative prompt with 400 (#11862)', async () => {
      imageGen.generateImage.mockClear();
      for (const body of [{ prompt: 'a\u0000b' }, { prompt: 'ok', negativePrompt: 'x\u0000' }]) {
        const response = await request(app).post('/api/image-gen/generate').send(body);
        expect(response.status).toBe(400);
      }
      expect(imageGen.generateImage).not.toHaveBeenCalled();
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
    // multipart referenceImage1..16 uploads. The schema accepts the array on a
    // JSON body too so a future internal caller (no files attached) doesn't
    // 400 just by listing weights.
    it('accepts up to 16 referenceStrengths entries within 0..1', async () => {
      imageGen.generateImage.mockResolvedValue({ generationId: 'gen-ref', filename: 'r.png', path: '/data/images/r.png' });
      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'multi-ref', referenceStrengths: Array(16).fill(0.5) });
      expect(response.status).toBe(200);
    });

    it('rejects a referenceStrengths entry outside 0..1', async () => {
      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'multi-ref', referenceStrengths: [0.5, 1.7] });
      expect(response.status).toBe(400);
    });

    it('rejects more than 16 referenceStrengths entries', async () => {
      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'multi-ref', referenceStrengths: Array(17).fill(0.5) });
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
        params: expect.objectContaining({ prompt: 'a fox in a forest', pythonPath: '/usr/bin/python3', modelId: 'qwen-image-2.1' }),
      }));
      // Synchronous generateImage MUST NOT be called in local mode — the
      // queue takes ownership of the job lifecycle.
      expect(imageGen.generateImage).not.toHaveBeenCalled();
      expect(recordUserAction).toHaveBeenCalledWith(expect.objectContaining({
        type: 'media.image.enqueue',
        target: 'queued-job-001',
        summary: 'enqueued image job',
        payload: { jobId: 'queued-job-001' },
      }));
      expect(JSON.stringify(recordUserAction.mock.calls[0][0])).not.toContain('a fox in a forest');
    });

    // Preview and submission must refuse the same input loss before queue admission.
    it.each([
      { initImageFile: 'init.png', initImageStrength: 0.35 },
      { loraFilenames: ['example.safetensors'] },
      { loraPaths: ['example.safetensors'] },
    ])('refuses FLUX.2 input loss in preview and submission: %j', async extra => {
      getSettings.mockResolvedValue({ imageGen: { mode: 'local' } });
      const body = { prompt: 'a red cube', modelId: 'flux2-klein-9b', referenceImageFiles: ['reference.png'], ...extra };
      const preview = await request(app).post('/api/image-gen/prompt-preview').send(body);
      const submit = await request(app).post('/api/image-gen/generate').send(body);
      expect([preview.status, preview.body.code]).toEqual([400, 'IMAGE_GEN_FLUX2_INPUTS_INCOMPATIBLE']);
      expect([submit.status, submit.body.code, submit.body.error]).toEqual([preview.status, preview.body.code, preview.body.error]);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(mediaJobQueue.assertMediaQueueRoom).not.toHaveBeenCalled();
    });

    it('refuses an incompatible FLUX.2 reference upload before staging it', async () => {
      getSettings.mockResolvedValue({ imageGen: { mode: 'local' } });
      const copy = vi.spyOn(fileUtils, 'copyFileGuarded');
      const server = await startLoopbackServer(app);
      try {
        const form = new FormData();
        form.set('modelId', 'flux2-klein-9b');
        form.set('loraFilenames', JSON.stringify(['example.safetensors']));
        form.set('referenceImage1', new Blob(['synthetic image'], { type: 'image/png' }), 'reference.png');
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/image-gen/generate`, { method: 'POST', body: form });
        expect(response.status).toBe(400);
        expect((await response.json()).code).toBe('IMAGE_GEN_FLUX2_INPUTS_INCOMPATIBLE');
        expect(copy).not.toHaveBeenCalled();
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      } finally {
        copy.mockRestore();
        await closeLoopbackServer(server);
      }
    });

    it.each([
      { initImageFile: 'init.png', initImageStrength: 0.35 },
      { referenceImageFiles: ['reference.png'], referenceStrengths: [0.4] },
      { loraFilenames: ['example.safetensors'], loraScales: [0.7] },
      { modelId: 'flux2-klein-9b-bf16', loraFilenames: ['example.safetensors'], referenceImageFiles: ['reference.png'], referenceStrengths: [0.4] },
    ])('preserves supported FLUX.2 neighbors in preview and queue: %j', async extra => {
      getSettings.mockResolvedValue({ imageGen: { mode: 'local' } });
      await fileUtils.ensureDir(fileUtils.PATHS.images);
      await fileUtils.ensureDir(fileUtils.PATHS.loras);
      await writeFile(pathJoin(fileUtils.PATHS.images, 'init.png'), 'synthetic init');
      await writeFile(pathJoin(fileUtils.PATHS.images, 'reference.png'), 'synthetic reference');
      await writeFile(pathJoin(fileUtils.PATHS.loras, 'example.safetensors'), 'synthetic adapter');
      const body = { prompt: 'a red cube', modelId: 'flux2-klein-9b', ...extra };
      const preview = await request(app).post('/api/image-gen/prompt-preview').send(body);
      const submit = await request(app).post('/api/image-gen/generate').send(body);
      expect([preview.status, submit.status]).toEqual([200, 200]);
      const params = mediaJobQueue.enqueueJob.mock.calls[0][0].params;
      if (extra.initImageFile) expect(params).toMatchObject({ initImagePath: pathJoin(fileUtils.PATHS.images, 'init.png'), initImageStrength: 0.35 });
      if (extra.referenceImageFiles) expect(params).toMatchObject({ referenceImagePaths: [pathJoin(fileUtils.PATHS.images, 'reference.png')], referenceImageStrengths: [0.4] });
      if (extra.loraFilenames) expect(params).toMatchObject({ loraFilenames: ['example.safetensors'], ...(extra.loraScales ? { loraScales: extra.loraScales } : {}) });
    });

    // #8326: a full media queue must answer with a retryable refusal before
    // any job id exists — and before the render's inputs are staged.
    it('answers a full media queue with a retryable 429 and no job id', async () => {
      const { mediaQueueFullError } = await import('../services/mediaJobQueue/admission.js');
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } });
      mediaJobQueue.assertMediaQueueRoom.mockImplementationOnce(() => { throw mediaQueueFullError({ pending: 250 }); });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fox in a forest' });

      expect(response.status).toBe(429);
      expect(response.body).toMatchObject({ code: 'MEDIA_QUEUE_FULL', context: { retryable: true, maxPendingJobs: 250 } });
      expect(response.body.jobId).toBeUndefined();
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(recordUserAction).not.toHaveBeenCalled();
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
      it('refuses a retained target before provider preparation or enqueue', async () => {
        const { assertCatalogIdentityWritable } = await import('../services/catalogDB/identityAccess.js');
        assertCatalogIdentityWritable.mockRejectedValueOnce(Object.assign(new Error('Retained original'), { status: 409, code: 'CATALOG_IDENTITY_RETAINED' }));
        const response = await request(app).post('/api/image-gen/generate').send({ prompt: 'example', catalogIngredientId: 'retained-original' });
        expect(response.status).toBe(409);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });
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

    // An explicit mflux model without a configured pythonPath rejects up-front
    // (400) rather than enqueueing a job that can never run. The new Qwen
    // default uses the shared diffusers runtime and does not require this path.
    it('mflux model with missing pythonPath returns 400 IMAGE_GEN_NOT_CONFIGURED', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local' } }); // no `local.pythonPath`

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fox in a forest', modelId: 'dev' });

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

    // #11317: the compose preview runs the same preparation and Codex builder as
    // /generate, so the form shows the wrapper and chips before anything queues.
    it('prompt-preview shows the exact Codex message and its additions without queueing', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'codex', codex: { enabled: true, codexPath: '/usr/local/bin/codex', model: 'gpt-5.4' } },
      });
      const style = { id: 'style-1', label: 'Universe style', text: 'muted earth tones' };

      const response = await request(app)
        .post('/api/image-gen/prompt-preview')
        .send({ prompt: 'muted earth tones. a tavern at dusk', width: 1024, height: 1024, promptAdditions: [style], uploadedInitImage: true });

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe('codex');
      expect(response.body.sentPrompt).toMatch(/^\$imagegen .*muted earth tones\. a tavern at dusk/s);
      expect(response.body.promptAdditions[0]).toEqual(style);
      expect(response.body.promptAdditions[1]).toMatchObject({ id: 'agent-instructions', label: 'Codex image tool instructions' });
      expect(response.body.promptAdditions[1].text).toContain('[prompt]');
      expect(response.body.promptAdditions[1].text).not.toContain('a tavern at dusk');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(mediaJobQueue.assertMediaQueueRoom).not.toHaveBeenCalled();
    });

    it('prompt-preview refuses a disabled provider the way Generate does', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'codex', codex: { enabled: false } } });
      const response = await request(app).post('/api/image-gen/prompt-preview').send({ prompt: 'a tavern at dusk' });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/disabled/);
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

    // Per-queue-item model override. `cloudModel` is dispatcher-level: it
    // replaces the provider's `model` and must NOT survive into the persisted
    // job params (the queue runner would hand the provider an unknown field).
    it('cloudModel overrides the saved cloud model for one queue item without leaking the raw field', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'codex', codex: { enabled: true, model: 'gpt-5.4' } },
      });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-codex-003', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a lighthouse', cloudModel: 'gpt-5.6-luna' });

      expect(response.status).toBe(200);
      expect(response.body.model).toBe('gpt-5.6-luna');
      const enqueued = mediaJobQueue.enqueueJob.mock.calls.at(-1)[0];
      expect(enqueued.params.model).toBe('gpt-5.6-luna');
      expect(enqueued.params).not.toHaveProperty('cloudModel');
    });

    // Agy is the backend the override was actually built for — exercise it
    // directly instead of inferring from the codex case. (Its unpinned default
    // is now the concrete AGY_IMAGEGEN_DEFAULT_MODEL cheap-tier pin, #3231.)
    it('agy: cloudModel replaces the configured-default sentinel for one queue item', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'agy', agy: { enabled: true, agyPath: '/opt/agy' } },
      });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-agy-001', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a lighthouse', cloudModel: 'gemini-3.1-pro-high' });

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe('agy');
      expect(response.body.model).toBe('gemini-3.1-pro-high');
      const enqueued = mediaJobQueue.enqueueJob.mock.calls.at(-1)[0];
      expect(enqueued.params.model).toBe('gemini-3.1-pro-high');
      expect(enqueued.params.agyPath).toBe('/opt/agy');
      expect(enqueued.params).not.toHaveProperty('cloudModel');
    });

    it('agy: an omitted cloudModel leaves the saved default in place', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'agy', agy: { enabled: true, model: 'gemini-3.5-flash-high' } },
      });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-agy-002', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a lighthouse' });

      expect(response.status).toBe(200);
      expect(response.body.model).toBe('gemini-3.5-flash-high');
      expect(mediaJobQueue.enqueueJob.mock.calls.at(-1)[0].params.model).toBe('gemini-3.5-flash-high');
    });

    // Defense-in-depth for the cheap-tier pin (#3231): a fully-unpinned agy
    // enqueue (no saved model, no cloudModel) must persist the concrete
    // default into the queue job — a refactor that stops spreading
    // cloud.jobParams into the enqueue would otherwise only fail at the
    // resolver-level test.
    it('agy: a fully-unpinned render enqueues the cheap-tier default model', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'agy', agy: { enabled: true } },
      });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-agy-003', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a lighthouse' });

      expect(response.status).toBe(200);
      expect(response.body.model).toBe(AGY_IMAGEGEN_DEFAULT_MODEL);
      expect(mediaJobQueue.enqueueJob.mock.calls.at(-1)[0].params.model).toBe(AGY_IMAGEGEN_DEFAULT_MODEL);
    });

    // No getSettings mock here on purpose: Zod rejects before the route ever
    // reads settings, and a queued mockResolvedValueOnce would leak into the
    // next test.
    it('rejects a cloudModel with shell-unsafe characters', async () => {
      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a lighthouse', cloudModel: '--dangerously-skip-permissions' });

      expect(response.status).toBe(400);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
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

      it.each([
        ['local', false],
        ['grok', false],
        ['agy', false],
        ['codex', true],
      ])('%s mode: omitted flags use the mode default without enabling denoise', async (mode, cleanC2PA) => {
        getSettings.mockResolvedValueOnce({
          imageGen: { mode, [mode]: { enabled: true, pythonPath: '/p' } },
        });

        const response = await request(app).post('/api/image-gen/generate').send({ prompt: 'p' });

        expect(response.status).toBe(200);
        expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
          params: expect.objectContaining({ cleanC2PA, denoise: false }),
        }));
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

      it('codex mode: explicit false overrides enabled cleaner settings', async () => {
        getSettings.mockResolvedValueOnce({
          imageGen: { mode: 'codex', codex: { enabled: true, cleanC2PA: true, denoise: true } },
        });

        await request(app).post('/api/image-gen/generate').send({ prompt: 'p', cleanC2PA: false, denoise: false });

        const [call] = mediaJobQueue.enqueueJob.mock.calls;
        expect(call[0].params.cleanC2PA).toBe(false);
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

    it('grok mode enqueues through mediaJobQueue with the saved grok params', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'grok', grok: { enabled: true, grokPath: '/usr/local/bin/grok', aspectRatio: '16:9' } },
      });
      mediaJobQueue.enqueueJob.mockReturnValueOnce({ jobId: 'queued-grok-001', position: 1, status: 'queued' });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a tavern at dusk' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('queued');
      expect(response.body.mode).toBe('grok');
      expect(response.body.jobId).toBe('queued-grok-001');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'image',
        params: expect.objectContaining({
          mode: 'grok',
          grokPath: '/usr/local/bin/grok',
          aspectRatio: '16:9',
          prompt: 'a tavern at dusk',
        }),
      }));
      // Synchronous generateImage MUST NOT be called in grok mode either —
      // the queue takes ownership.
      expect(imageGen.generateImage).not.toHaveBeenCalled();
    });

    it('grok mode with disabled toggle returns 400 GROK_IMAGEGEN_DISABLED', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'grok', grok: { enabled: false } },
      });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: 'a fox' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/disabled/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('rejects a Grok text-to-image request with no prompt and no init image (synchronous 400)', async () => {
      getSettings.mockResolvedValueOnce({
        imageGen: { mode: 'grok', grok: { enabled: true } },
      });

      const response = await request(app)
        .post('/api/image-gen/generate')
        .send({ prompt: '' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/prompt is required/i);
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

  // Explicit-target contract (#9932): a named id cancels that job or nothing —
  // it never degrades to bulk cancellation or to a different live job.
  describe('POST /cancel explicit-target contract', () => {
    it.each([
      ['array', []],
      ['object', {}],
      ['null', null],
      ['whitespace', '   '],
      ['number', 7],
    ])('rejects a %s jobId with 400 and cancels nothing', async (_label, jobId) => {
      // Validation runs before any job lookup, so no queue state is needed.
      const response = await request(app).post('/api/image-gen/cancel').send({ jobId });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(mediaJobQueue.cancelJob).not.toHaveBeenCalled();
      expect(imageGen.cancelJob).not.toHaveBeenCalled();
      expect(imageGen.cancel).not.toHaveBeenCalled();
    });

    it('rejects a non-boolean all flag with 400', async () => {
      const response = await request(app).post('/api/image-gen/cancel').send({ all: 'yes' });
      expect(response.status).toBe(400);
      expect(mediaJobQueue.cancelJob).not.toHaveBeenCalled();
      expect(imageGen.cancel).not.toHaveBeenCalled();
    });

    it('409s for a known terminal job without touching live job B or any bulk method', async () => {
      mediaJobQueue.listJobs.mockReturnValueOnce([
        { id: 'running-b', kind: 'image', status: 'running' },
        { id: 'finished-a', kind: 'image', status: 'completed' },
      ]);
      const response = await request(app).post('/api/image-gen/cancel').send({ jobId: 'finished-a' });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('ALREADY_TERMINAL');
      expect(mediaJobQueue.cancelJob).not.toHaveBeenCalled();
      expect(imageGen.cancelJob).not.toHaveBeenCalled();
      expect(imageGen.cancel).not.toHaveBeenCalled();
    });

    it('404s for an unknown id after asking providers for that exact id only', async () => {
      mediaJobQueue.listJobs.mockReturnValueOnce([{ id: 'running-b', kind: 'image', status: 'running' }]);
      imageGen.cancelJob.mockReturnValueOnce(false);
      const response = await request(app).post('/api/image-gen/cancel').send({ jobId: 'expired-a' });
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
      expect(imageGen.cancelJob).toHaveBeenCalledWith('expired-a');
      expect(mediaJobQueue.cancelJob).not.toHaveBeenCalled();
      expect(imageGen.cancel).not.toHaveBeenCalled();
    });

    it('cancels an exact legacy-provider job the queue does not know, never the bulk path', async () => {
      mediaJobQueue.listJobs.mockReturnValueOnce([]);
      imageGen.cancelJob.mockReturnValueOnce(true);
      const response = await request(app).post('/api/image-gen/cancel').send({ jobId: ' codex-1 ' });
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(imageGen.cancelJob).toHaveBeenCalledWith('codex-1');
      expect(imageGen.cancel).not.toHaveBeenCalled();
    });

    it('maps a queue-reported ALREADY_TERMINAL race (job finished mid-request) to 409', async () => {
      mediaJobQueue.listJobs.mockReturnValueOnce([{ id: 'racing', kind: 'image', status: 'running' }]);
      mediaJobQueue.cancelJob.mockResolvedValueOnce({ ok: false, code: 'ALREADY_TERMINAL', status: 'completed', error: 'Job is already finishing' });
      const response = await request(app).post('/api/image-gen/cancel').send({ jobId: 'racing' });
      expect(response.status).toBe(409);
      expect(imageGen.cancel).not.toHaveBeenCalled();
    });
  });

  describe('FLUX.2 installer contract', () => {
    it('GET /setup/flux2-install reports status without starting an install', async () => {
      const { installFlux2Venv, isFlux2InstallSatisfied } = await import('../lib/pythonSetup.js');
      isFlux2InstallSatisfied.mockResolvedValueOnce(false);
      const response = await request(app).get('/api/image-gen/setup/flux2-install');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        venvInstalled: false,
        expectedVenvPath: '/fake/flux2-venv',
      });
      expect(installFlux2Venv).not.toHaveBeenCalled();
    });

    it('POST /setup/flux2-install keeps the existing SSE completion contract', async () => {
      const response = await request(app).post('/api/image-gen/setup/flux2-install');
      expect(response.status).toBe(200);
      expect(response.text).toContain('"type":"complete"');
      expect(response.text).toContain('Already installed');
    });

    // The Install button appeared BECAUSE the per-model verdict probed that
    // model's own pipeline class; the installer's gate has to ask the same
    // question or it answers a real gap with "nothing to do".
    it('POST /setup/flux2-install scopes the already-installed gate to the selected model pipeline', async () => {
      const { isFlux2InstallSatisfied } = await import('../lib/pythonSetup.js');
      await request(app).post('/api/image-gen/setup/flux2-install?modelId=qwen-image-2.1');
      expect(isFlux2InstallSatisfied).toHaveBeenCalledWith('QwenImage21Pipeline');
    });

    // The client renders a stream that closes with no terminal frame as
    // "Connection to installer lost. Restart PortOS or try again." — a phantom
    // transport error that hides the real failure. installFlux2Venv emits its
    // own error frame; this is the route's backstop for a path that doesn't.
    it('POST /setup/flux2-install reports a silent installer failure instead of closing the stream bare', async () => {
      const { installFlux2Venv, isFlux2InstallSatisfied } = await import('../lib/pythonSetup.js');
      isFlux2InstallSatisfied.mockResolvedValueOnce(false);
      installFlux2Venv.mockReturnValueOnce({
        promise: Promise.resolve({ ok: false, stage: 'install' }),
        kill: vi.fn(),
      });

      const response = await request(app).post('/api/image-gen/setup/flux2-install');

      expect(response.status).toBe(200);
      expect(response.text).toContain('"type":"error"');
      expect(response.text).toContain('failed at the install stage');
    });

    it('POST /setup/flux2-install stays silent when the client cancelled the install', async () => {
      const { installFlux2Venv, isFlux2InstallSatisfied } = await import('../lib/pythonSetup.js');
      isFlux2InstallSatisfied.mockResolvedValueOnce(false);
      installFlux2Venv.mockReturnValueOnce({
        promise: Promise.resolve({ ok: false, stage: 'install', cancelled: true }),
        kill: vi.fn(),
      });

      const response = await request(app).post('/api/image-gen/setup/flux2-install');

      expect(response.text).not.toContain('"type":"error"');
    });

    it('does not start an install after the client disconnects during the health probe', async () => {
      const { installFlux2Venv, isFlux2InstallSatisfied } = await import('../lib/pythonSetup.js');
      let finishProbe;
      isFlux2InstallSatisfied.mockReturnValueOnce(new Promise((resolve) => { finishProbe = resolve; }));
      const server = await startLoopbackServer(app);
      const { port } = server.address();
      const clientRequest = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/api/image-gen/setup/flux2-install',
        method: 'POST',
      });
      clientRequest.on('error', () => {});
      clientRequest.end();

      let serverClosed = false;
      try {
        await vi.waitFor(() => expect(isFlux2InstallSatisfied).toHaveBeenCalled());
        const closed = new Promise((resolve) => clientRequest.once('close', resolve));
        clientRequest.destroy();
        await closed;
        await vi.waitFor(() => expect(disconnectLifecycle.onDisconnect).toHaveBeenCalled());
        finishProbe(false);
        await closeLoopbackServer(server);
        serverClosed = true;
        expect(installFlux2Venv).not.toHaveBeenCalled();
      } finally {
        finishProbe?.(false);
        if (!serverClosed) await closeLoopbackServer(server);
      }
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

    it('GET /setup/install reports setup status without starting pip', async () => {
      const { installPackages } = await import('../lib/pythonSetup.js');
      const p = '/usr/bin/python3-install-status-test';
      const status = await request(app).get(`/api/image-gen/setup/install?pythonPath=${encodeURIComponent(p)}&packages=mflux`);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ installed: ['mflux', 'mlx'], missing: [] });
      expect(installPackages).not.toHaveBeenCalled();
    });

    it('POST /setup/install completion invalidates the cache for that pythonPath', async () => {
      const p = '/usr/bin/python3-install-bust-test';
      // Warm cache.
      await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(p)}`);
      expect(probePythonHealth).toHaveBeenCalledTimes(1);

      // Run install (mocked installPackages resolves immediately).
      const installRes = await request(app).post(`/api/image-gen/setup/install?pythonPath=${encodeURIComponent(p)}&packages=mflux`);
      expect(installRes.status).toBe(200);

      // The next /setup/check must re-probe — the install just changed the
      // missing-packages list, and the SSE consumer re-runs /setup/check on
      // `complete` expecting fresh data.
      await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(p)}`);
      expect(probePythonHealth).toHaveBeenCalledTimes(2);
    });

    it('POST /setup/install rejects invalid packages with the standard error envelope', async () => {
      const p = '/usr/bin/python3-install-validation-test';
      const response = await request(app).post(`/api/image-gen/setup/install?pythonPath=${encodeURIComponent(p)}&packages=not-allowed`);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: 'INSTALL_PACKAGE_NOT_ALLOWED',
        error: expect.stringContaining('not-allowed'),
      });
      expect(response.body.timestamp).toEqual(expect.any(Number));
    });

    it('single-flights package installs per interpreter without treating a completed POST body as a disconnect', async () => {
      const { installPackages } = await import('../lib/pythonSetup.js');
      let finishInstall;
      const pending = new Promise((resolve) => { finishInstall = resolve; });
      const kill = vi.fn();
      installPackages.mockReturnValueOnce({ promise: pending, kill });
      const p = '/usr/bin/python3-install-single-flight-test';
      const url = `/api/image-gen/setup/install?pythonPath=${encodeURIComponent(p)}&packages=mflux`;

      const first = request(app).post(url).then((response) => response);
      await vi.waitFor(() => expect(installPackages).toHaveBeenCalledTimes(1));
      expect(kill).not.toHaveBeenCalled();

      const second = await request(app).post(url);
      expect(second.text).toContain('Another package install is already running');
      expect(installPackages).toHaveBeenCalledTimes(1);

      finishInstall({ ok: true, code: 0 });
      expect((await first).status).toBe(200);
      expect(kill).not.toHaveBeenCalled();
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
    let restorePlatform = () => {};
    let probePythonHealth, detectArm64Python;

    beforeEach(async () => {
      restorePlatform = pinPlatform('darwin');
      const mod = await import('../lib/pythonSetup.js');
      probePythonHealth = mod.probePythonHealth;
      detectArm64Python = mod.detectArm64Python;
      mockStat.mockReset();
      mockStat.mockResolvedValue({ mtimeMs: 1_700_000_000_000 });
    });

    afterEach(() => {
      restorePlatform();
      hostArchHolder.value = 'arm64';
      hostArchHolder.appleSilicon = undefined;
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
      pinPlatform('linux'); // afterEach restores the pristine descriptor
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

    it('flags archMismatch when Node is x64 but the Mac is Apple Silicon', async () => {
      hostArchHolder.value = 'x86_64';
      hostArchHolder.appleSilicon = true;
      probePythonHealth.mockResolvedValueOnce({
        installed: [], missing: [], missingPip: [],
        externallyManaged: false, interpreterArch: 'x86_64',
      });
      detectArm64Python.mockResolvedValueOnce('/opt/homebrew/bin/python3');
      const r = await request(app).get(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent('/arch-fields-rosetta')}`);
      expect(r.status).toBe(200);
      expect(r.body.hostArch).toBe('arm64');
      expect(r.body.archMismatch).toBe(true);
      expect(r.body.suggestedArm64Python).toBe('/opt/homebrew/bin/python3');
      expect(detectArm64Python).toHaveBeenCalled();
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

  describe('POST /api/image-gen/generate — federated media provider', () => {
    it('previews and queues a reviewed peer reference even when the local default is text-only', async () => {
      await fileUtils.ensureDir(fileUtils.PATHS.images);
      await writeFile(pathJoin(fileUtils.PATHS.images, 'peer-reviewed.png'), 'reviewed peer image');
      const body = { prompt: 'Edit the scene', modelId: 'dev', mediaProviderPeerId: federatedPeerId, referenceImageFiles: ['peer-reviewed.png'] };
      const preview = await request(app).post('/api/image-gen/prompt-preview').send({ ...body, reviewReference: true });
      expect(preview.status).toBe(200);
      expect(preview.body.remote).toBe(true);
      expect(preview.body.sentPrompt).toBe(body.prompt);
      const response = await request(app).post('/api/image-gen/generate').send({ ...body, reviewedReferenceDigest: preview.body.reviewedReferenceDigest });
      expect(response.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({
        reviewedReferenceDigest: preview.body.reviewedReferenceDigest,
        remoteMedia: expect.objectContaining({ inputAssets: [expect.objectContaining({ role: 'referenceImages' })] }),
      }) }));
    });

    it('submits to the selected peer and keeps the prompt inside the versioned marker', async () => {
      const response = await request(app).post('/api/image-gen/generate').send({
        prompt: 'a lighthouse at dusk',
        modelId: 'dev',
        width: 512,
        height: 512,
        seed: 42,
        mediaProviderPeerId: federatedPeerId,
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        jobId: 'mock-image-job',
        // No local backend renders this, so `mode` must not name one.
        mode: null,
        model: 'dev',
        mediaProviderPeerId: federatedPeerId,
      });
      expect(prepareRemoteMediaJob).toHaveBeenCalledWith({
        peerId: federatedPeerId,
        kind: 'image',
        request: {
          kind: 'image',
          engine: 'local',
          modelId: 'dev',
          prompt: 'a lighthouse at dusk',
          width: 512,
          height: 512,
          seed: 42,
        },
        // A text-to-image render carries none, but the field is always passed —
        // an empty list and an absent one must read the same to the submitter.
        inputAssets: [],
      });

      const [{ params }] = mediaJobQueue.enqueueJob.mock.calls[0];
      // The conditioning prompt rides only inside the versioned marker, and the
      // routing fields never reach the queue. enqueueJob owns blanking the
      // local render fields on top of this (#4683) — its own suites cover that,
      // and enqueueJob is mocked here.
      expect(params.remoteMedia.request.prompt).toBe('a lighthouse at dusk');
      expect(params.remoteMedia.request.modelId).toBe('dev');
      expect(params).not.toHaveProperty('mediaProviderPeerId');
      expect(params).not.toHaveProperty('mediaProviderEngine');
    });

    it('requires an explicit provider model instead of falling back to a local default', async () => {
      const response = await request(app).post('/api/image-gen/generate').send({
        prompt: 'a lighthouse at dusk',
        mediaProviderPeerId: federatedPeerId,
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('MEDIA_PROVIDER_MODEL_REQUIRED');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('previews a peer reference independently of a disabled local cloud backend', async () => {
      await fileUtils.ensureDir(fileUtils.PATHS.images);
      await writeFile(pathJoin(fileUtils.PATHS.images, 'peer-disabled-local.png'), 'reviewed peer image');
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'codex', codex: { enabled: false } } });
      const response = await request(app).post('/api/image-gen/prompt-preview').send({
        prompt: 'Edit the scene', modelId: 'dev', mediaProviderPeerId: federatedPeerId,
        referenceImageFiles: ['peer-disabled-local.png'], reviewReference: true,
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ remote: true, sentPrompt: 'Edit the scene', reviewedReferenceDigest: expect.any(String) });
    });

    it('does not substitute the local model for an unnamed peer model', async () => {
      getSettings.mockResolvedValueOnce({ imageGen: { mode: 'local', local: { modelId: 'qwen-image-2.1' } } });
      const response = await request(app).post('/api/image-gen/generate').send({ prompt: 'a lighthouse', mediaProviderPeerId: federatedPeerId });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('MEDIA_PROVIDER_MODEL_REQUIRED');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('refuses a federated render that carries conditioning the wire cannot take', async () => {
      const response = await request(app).post('/api/image-gen/generate').send({
        prompt: 'a lighthouse at dusk',
        modelId: 'dev',
        loraFilenames: ['style.safetensors'],
        mediaProviderPeerId: federatedPeerId,
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('MEDIA_PROVIDER_INPUT_UNSUPPORTED');
      expect(response.body.error).toMatch(/LoRA weights/);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(prepareRemoteMediaJob).not.toHaveBeenCalled();
    });
  });

});
