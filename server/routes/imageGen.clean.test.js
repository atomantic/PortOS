import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import sharp from 'sharp';
import { mkdtemp, rm, writeFile, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Sandbox PATHS.images to a tmp dir so the clean endpoint can read/write real
// files without touching data/images/. The mock has to be installed BEFORE the
// route module imports fileUtils.js, hence the dynamic import below.
let sandbox;

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...actual,
    get PATHS() {
      return { ...actual.PATHS, images: sandbox };
    },
  };
});

// Partial mock: keep the real `local` namespace (for assertGalleryFilename /
// readImageSidecar / etc.) and just stub out the dispatcher entry points so
// /generate doesn't try to spin up an actual provider during tests.
vi.mock('../services/imageGen/index.js', async () => {
  const actual = await vi.importActual('../services/imageGen/index.js');
  return {
    ...actual,
    checkConnection: vi.fn(),
    generateImage: vi.fn(),
    generateAvatar: vi.fn(),
    attachSseClient: vi.fn(() => false),
    cancel: vi.fn(() => false),
  };
});

vi.mock('../services/settings.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  getSettings: vi.fn(async () => ({ imageGen: { mode: 'external' } })),
  settingsEvents: { on: () => {}, emit: () => {} },
}));

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(),
  attachSseClient: vi.fn(() => false),
  cancelJob: vi.fn(),
  listJobs: vi.fn(() => []),
}));

// Mock the collections service so the clean route's auto-file behavior is
// observable + the tests don't depend on PATHS.data state. Default
// `listCollections` returns empty, which makes the auto-file step a no-op for
// every test that doesn't override the mock. Tests that exercise auto-file
// re-configure `listCollectionsMock` per-case.
const { listCollectionsMock, addItemMock } = vi.hoisted(() => ({
  listCollectionsMock: vi.fn(async () => []),
  addItemMock: vi.fn(async () => ({})),
}));
vi.mock('../services/mediaCollections.js', () => ({
  listCollections: listCollectionsMock,
  addItem: addItemMock,
  ERR_DUPLICATE: 'DUPLICATE',
}));

let imageGenRoutes;
let pngFixture;

beforeAll(async () => {
  // Tmp dir created before route import so the mocked PATHS.images resolves
  // to a real path when the route reads from it.
  sandbox = await mkdtemp(join(tmpdir(), 'portos-imageclean-'));
  ({ default: imageGenRoutes } = await import('./imageGen.js'));
  // Noisy 16×16 RGB so the resize-squeeze round-trip visibly moves pixels.
  // A solid-color fixture would round-trip near-identically.
  const raw = Buffer.alloc(16 * 16 * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 73 + 11) % 256;
  pngFixture = await sharp(raw, { raw: { width: 16, height: 16, channels: 3 } })
    .png()
    .toBuffer();
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('POST /api/image-gen/:filename/clean', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/image-gen', imageGenRoutes);
    app.use(errorMiddleware);
    listCollectionsMock.mockReset();
    listCollectionsMock.mockResolvedValue([]);
    addItemMock.mockReset();
    addItemMock.mockResolvedValue({});
  });

  it('cleans an existing PNG and writes _clean-resize-squeeze.png back to the gallery', async () => {
    await writeFile(join(sandbox, 'render-1.png'), pngFixture);
    await writeFile(join(sandbox, 'render-1.metadata.json'), JSON.stringify({
      prompt: 'a red square', seed: 42, modelId: 'flux-v1',
    }));

    const res = await request(app).post('/api/image-gen/render-1.png/clean').send({});
    expect(res.status).toBe(200);
    expect(res.body.filename).toBe('render-1_clean-resize-squeeze.png');
    expect(res.body.cleanedFrom).toBe('render-1.png');
    expect(res.body.cleanLevel).toBe('resize-squeeze');
    // Source sidecar carried forward so the cleaned copy retains lineage.
    expect(res.body.prompt).toBe('a red square');
    expect(res.body.seed).toBe(42);
    expect(res.body.modelId).toBe('flux-v1');

    expect(existsSync(join(sandbox, 'render-1_clean-resize-squeeze.png'))).toBe(true);
    expect(existsSync(join(sandbox, 'render-1_clean-resize-squeeze.metadata.json'))).toBe(true);
  });

  it('idempotent: running clean twice overwrites instead of accumulating', async () => {
    await writeFile(join(sandbox, 'render-3.png'), pngFixture);
    const first = await request(app).post('/api/image-gen/render-3.png/clean').send({});
    const second = await request(app).post('/api/image-gen/render-3.png/clean').send({});
    expect(first.body.filename).toBe(second.body.filename);
    expect(first.body.filename).toBe('render-3_clean-resize-squeeze.png');
  });

  it('rejects non-PNG filenames (gallery is PNG-only)', async () => {
    const res = await request(app).post('/api/image-gen/render.jpg/clean').send({});
    expect(res.status).toBe(400);
  });

  it('rejects path-traversal in filename', async () => {
    const res = await request(app).post('/api/image-gen/' + encodeURIComponent('../etc/passwd.png') + '/clean').send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when the source image does not exist', async () => {
    const res = await request(app).post('/api/image-gen/does-not-exist.png/clean').send({});
    expect(res.status).toBe(404);
  });

  it('writes a sidecar that records the cleaning lineage', async () => {
    await writeFile(join(sandbox, 'render-6.png'), pngFixture);
    await request(app).post('/api/image-gen/render-6.png/clean').send({});
    const sidecar = JSON.parse(await readFile(join(sandbox, 'render-6_clean-resize-squeeze.metadata.json'), 'utf-8'));
    expect(sidecar.cleanedFrom).toBe('render-6.png');
    expect(sidecar.cleanLevel).toBe('resize-squeeze');
    expect(typeof sidecar.createdAt).toBe('string');
  });

  it('strips hidden=true from the cleaned copy so it surfaces in the gallery', async () => {
    await writeFile(join(sandbox, 'render-hidden.png'), pngFixture);
    await writeFile(join(sandbox, 'render-hidden.metadata.json'), JSON.stringify({
      prompt: 'a hidden render', hidden: true,
    }));
    const res = await request(app).post('/api/image-gen/render-hidden.png/clean').send({});
    expect(res.status).toBe(200);
    expect(res.body.hidden).toBeUndefined();
    expect(res.body.prompt).toBe('a hidden render');

    const sidecar = JSON.parse(await readFile(join(sandbox, 'render-hidden_clean-resize-squeeze.metadata.json'), 'utf-8'));
    expect(sidecar.hidden).toBeUndefined();
  });

  it('accepts legitimate filenames containing `..` substring (not exact `..`)', async () => {
    await writeFile(join(sandbox, 'my..render.png'), pngFixture);
    const res = await request(app).post(`/api/image-gen/${encodeURIComponent('my..render.png')}/clean`).send({});
    expect(res.status).toBe(200);
    expect(res.body.filename).toBe('my..render_clean-resize-squeeze.png');
  });

  it('output file size is reflected in sizeBytes / sizeAfter', async () => {
    await writeFile(join(sandbox, 'render-7.png'), pngFixture);
    const res = await request(app).post('/api/image-gen/render-7.png/clean').send({});
    const s = await stat(join(sandbox, res.body.filename));
    expect(res.body.sizeBytes).toBe(s.size);
    expect(res.body.sizeAfter).toBe(s.size);
  });

  describe('auto-file cleaned image into source collections', () => {
    it('adds the cleaned filename to every collection that contained the source', async () => {
      await writeFile(join(sandbox, 'render-coll.png'), pngFixture);
      listCollectionsMock.mockResolvedValue([
        { id: 'col-a', items: [{ kind: 'image', ref: 'render-coll.png' }] },
        { id: 'col-b', items: [{ kind: 'image', ref: 'render-coll.png' }, { kind: 'image', ref: 'other.png' }] },
        { id: 'col-c-unrelated', items: [{ kind: 'image', ref: 'other.png' }] },
      ]);

      const res = await request(app).post('/api/image-gen/render-coll.png/clean').send({});
      expect(res.status).toBe(200);

      // Only the two collections containing the source get the cleaned copy.
      // Order is non-deterministic (Promise.all), so assert by call set.
      expect(addItemMock).toHaveBeenCalledTimes(2);
      const calls = addItemMock.mock.calls.map(([id, item]) => ({ id, item }));
      expect(calls).toEqual(expect.arrayContaining([
        { id: 'col-a', item: { kind: 'image', ref: 'render-coll_clean-resize-squeeze.png' } },
        { id: 'col-b', item: { kind: 'image', ref: 'render-coll_clean-resize-squeeze.png' } },
      ]));
      expect(calls.find((c) => c.id === 'col-c-unrelated')).toBeUndefined();
    });

    it('is a no-op when the source is not in any collection', async () => {
      await writeFile(join(sandbox, 'render-orphan.png'), pngFixture);
      listCollectionsMock.mockResolvedValue([
        { id: 'col-x', items: [{ kind: 'image', ref: 'something-else.png' }] },
      ]);

      const res = await request(app).post('/api/image-gen/render-orphan.png/clean').send({});
      expect(res.status).toBe(200);
      expect(addItemMock).not.toHaveBeenCalled();
    });

    it('swallows ERR_DUPLICATE so re-cleans of an already-filed pair are idempotent', async () => {
      await writeFile(join(sandbox, 'render-dup.png'), pngFixture);
      listCollectionsMock.mockResolvedValue([
        { id: 'col-dup', items: [{ kind: 'image', ref: 'render-dup.png' }] },
      ]);
      addItemMock.mockRejectedValue(Object.assign(new Error('Item already in collection'), { code: 'DUPLICATE' }));

      const res = await request(app).post('/api/image-gen/render-dup.png/clean').send({});
      // The clean itself succeeds; the duplicate is swallowed.
      expect(res.status).toBe(200);
      expect(res.body.filename).toBe('render-dup_clean-resize-squeeze.png');
    });

    it('clean succeeds even if listCollections throws (best-effort)', async () => {
      await writeFile(join(sandbox, 'render-listfail.png'), pngFixture);
      listCollectionsMock.mockRejectedValue(new Error('disk full'));

      const res = await request(app).post('/api/image-gen/render-listfail.png/clean').send({});
      expect(res.status).toBe(200);
      expect(res.body.filename).toBe('render-listfail_clean-resize-squeeze.png');
      // The cleaned file still landed on disk.
      expect(existsSync(join(sandbox, 'render-listfail_clean-resize-squeeze.png'))).toBe(true);
    });

    it('clean succeeds even when one addItem throws a non-DUPLICATE error (best-effort, others still fire)', async () => {
      await writeFile(join(sandbox, 'render-mixed.png'), pngFixture);
      listCollectionsMock.mockResolvedValue([
        { id: 'col-ok', items: [{ kind: 'image', ref: 'render-mixed.png' }] },
        { id: 'col-fail', items: [{ kind: 'image', ref: 'render-mixed.png' }] },
      ]);
      addItemMock.mockImplementation(async (id) => {
        if (id === 'col-fail') throw new Error('collection write blew up');
        return {};
      });

      const res = await request(app).post('/api/image-gen/render-mixed.png/clean').send({});
      expect(res.status).toBe(200);
      // Both ids were attempted — the success path doesn't short-circuit on
      // a sibling failure.
      expect(addItemMock).toHaveBeenCalledTimes(2);
    });
  });
});
