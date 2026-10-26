import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';
import { AsyncLocalStorage } from 'node:async_hooks';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const uploadTrace = new AsyncLocalStorage();

// Log starts as well as settlements: a timed-out worker may never reach finally.
// Direct output survives CI quiet mode; only fixed labels, timings, and the
// expected missing-staging code leave the fixture, never paths or metadata.
function beginStage(stage) {
  if (!uploadTrace.getStore()) return () => {};
  const start = performance.now();
  const event = { stage, state: 'running' };
  process.stdout.write(`📥 Gallery upload stage ${JSON.stringify(event)}\n`);
  return (state = 'fulfilled', code) => {
    if (event.state !== 'running') return;
    event.state = state;
    if (code === 'ENOENT') event.code = 'ENOENT';
    event.elapsedMs = Math.round(performance.now() - start);
    process.stdout.write(`📥 Gallery upload stage ${JSON.stringify(event)}\n`);
  };
}

async function measureStage(stage, work) {
  const finish = beginStage(stage);
  try {
    const value = await work();
    finish();
    return value;
  } catch (error) {
    finish('rejected', error.code);
    throw error;
  }
}

// Own the entire test continuation, including setup and assertions. Vitest's
// timeout abandons its waiter; it does not cancel native Sharp or filesystem work.
function ownFixture(root) {
  const pending = new Set();
  let closing = false;
  const settle = () => Promise.all([...pending]);
  return {
    run(work, trace = false) {
      if (closing) throw new Error('Gallery fixture is closing');
      const operation = Promise.resolve().then(() => uploadTrace.run(trace, work));
      const terminal = operation.then(() => {}, () => {});
      pending.add(terminal);
      void terminal.then(() => pending.delete(terminal));
      return operation;
    },
    settle,
    async cleanup() {
      closing = true;
      await settle();
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(root)).toBe(false);
    },
  };
}

vi.mock('../../lib/pngMetadata.js', async original => {
  const actual = await original();
  return { ...actual, extractPngGenerationMetadataFile: (...args) =>
    measureStage('metadata-read', () => actual.extractPngGenerationMetadataFile(...args)) };
});

vi.mock('../../lib/backupSnapshotBoundary.js', async original => {
  const actual = await original();
  return { ...actual, withBackupAssetPublication: async (work, ...args) => {
    const admitted = beginStage('backup-admission');
    try {
      return await actual.withBackupAssetPublication(() => {
        admitted();
        return measureStage('publication', work);
      }, ...args);
    } finally {
      admitted('rejected');
    }
  } };
});

vi.mock('fs/promises', async original => {
  const actual = await original();
  return { ...actual, rename: (...args) => measureStage('publish-rename', () => actual.rename(...args)) };
});

vi.mock('../mediaAssetIndex/index.js', async original => {
  const actual = await original();
  return { ...actual, indexImage: (...args) => measureStage('index-refresh', () => actual.indexImage(...args)) };
});

// The PNG 8-byte signature — used to assert a written gallery file is a PNG
// without importing from the (mocked) fileUtils module.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (buf) => buf.subarray(0, 8).equals(PNG_SIGNATURE);

const crc32 = (value) => {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(body), data.length + 8);
  return chunk;
};

const addPngText = (png, keyword, text) => Buffer.concat([
  png.subarray(0, -12),
  pngChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text)])),
  png.subarray(-12),
]);

// Redirect PATHS.images at a per-test temp dir so saving an uploaded image
// writes into the temp gallery, not the repo's real data/images.
let imagesDir;
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, {
    dataRoot: () => imagesDir, // unused root; images override below is what matters
    extraOverrides: () => ({ images: imagesDir }),
    overrides: {
      ensureDir: (...args) => measureStage('gallery-directory', () => actual.ensureDir(...args)),
      atomicWrite: (...args) => measureStage('sidecar-write', () => actual.atomicWrite(...args)),
      unlinkGuarded: (...args) => measureStage('staging-cleanup', () => actual.unlinkGuarded(...args)),
    },
  });
});

// local.js imports pythonSetup at load; stub it so the module loads without
// resolving a real venv (mirrors local.test.js).
vi.mock('../../lib/pythonSetup.js', () => ({
  resolveFlux2Python: () => null,
  FLUX2_VENV_DEFAULT: '/fake/home/.portos/venv-flux2/bin/python3',
}));

let tmpRoot;
let fixture;
let priorRegistryEnv;
let saveUploadedGalleryImage;

// A real 1x1 GIF89a (sharp can decode it). Real PNG/JPEG are built in beforeAll.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
let realPng;
let realJpeg;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'portos-gallery-upload-test-'));
  imagesDir = join(tmpRoot, 'images');
  fixture = ownFixture(tmpRoot);
  return fixture.run(async () => {
    const toFile = sharp.prototype.toFile;
    vi.spyOn(sharp.prototype, 'toFile').mockImplementation(function (...args) {
      return measureStage('sharp-encode', () => toFile.apply(this, args));
    });
    priorRegistryEnv = process.env.PORTOS_MEDIA_MODELS_FILE;
    process.env.PORTOS_MEDIA_MODELS_FILE = join(tmpRoot, 'media-models.json');
    realPng = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    realJpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 40, g: 50, b: 60 } } }).jpeg().toBuffer();
    vi.resetModules();
    ({ saveUploadedGalleryImage } = await import('./local.js'));
  });
});

afterEach(async () => {
  await fixture?.settle();
});

afterAll(async () => {
  await fixture?.cleanup();
  vi.restoreAllMocks();
  if (priorRegistryEnv === undefined) delete process.env.PORTOS_MEDIA_MODELS_FILE;
  else process.env.PORTOS_MEDIA_MODELS_FILE = priorRegistryEnv;
});

describe('saveUploadedGalleryImage', () => {
  it('writes a PNG into the gallery and returns a /data/images path', () => fixture.run(async () => {
    const { filename, path } = await saveUploadedGalleryImage(realPng.toString('base64'));
    expect(filename).toMatch(/^upload-[0-9a-f]{8}\.png$/);
    expect(path).toBe(`/data/images/${filename}`);
    expect(existsSync(join(imagesDir, filename))).toBe(true);
    // Written file is a valid PNG (so the gallery's PNG-only list/delete manage it).
    expect(isPng(readFileSync(join(imagesDir, filename)))).toBe(true);
  }));

  it('normalizes a non-PNG upload (GIF/JPEG) to a managed .png gallery file', () => fixture.run(async () => {
    for (const src of [GIF, realJpeg]) {
      const { filename } = await saveUploadedGalleryImage(src.toString('base64'));
      expect(filename.endsWith('.png')).toBe(true);
      expect(isPng(readFileSync(join(imagesDir, filename)))).toBe(true);
    }
  }));

  it('extracts Stable Diffusion parameters before normalization and writes a sidecar', () => fixture.run(async () => {
    const source = addPngText(realPng, 'parameters', [
      'a paper boat on a moonlit lake',
      'Negative prompt: blurry, text',
      'Steps: 24, Sampler: DPM++ 2M, CFG scale: 7.5, Seed: 42, Size: 768x512, Model hash: abc123, Model: example-model',
    ].join('\n'));
    const { filename, metadata } = await saveUploadedGalleryImage(source.toString('base64'));
    expect(metadata).toMatchObject({
      format: 'a1111', prompt: 'a paper boat on a moonlit lake', negativePrompt: 'blurry, text',
      steps: 24, sampler: 'DPM++ 2M', cfgScale: 7.5, seed: 42, width: 768, height: 512,
      modelHash: 'abc123', model: 'example-model',
    });
    const sidecar = join(imagesDir, filename.replace('.png', '.metadata.json'));
    expect(JSON.parse(readFileSync(sidecar, 'utf8'))).toMatchObject(metadata);
  }));

  it('rejects an empty upload with a 400', () => fixture.run(async () => {
    await expect(saveUploadedGalleryImage('')).rejects.toMatchObject({ status: 400 });
  }));

  it('rejects non-image bytes with a 400', () => fixture.run(async () => {
    await expect(
      saveUploadedGalleryImage(Buffer.from('definitely not an image').toString('base64')),
    ).rejects.toMatchObject({ status: 400, code: 'UNSUPPORTED_IMAGE' });
  }));

  it('imports a staged PNG and preserves its generation metadata', () => fixture.run(async () => {
    const png = await measureStage('fixture-encode', () =>
      sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer());
    const source = addPngText(png, 'parameters', 'A test image\nSteps: 20, Seed: 42');
    const tempPath = join(tmpRoot, 'staged.png');
    await measureStage('fixture-write', () => writeFileSync(tempPath, source));
    const saved = await measureStage('upload', () => saveUploadedGalleryImage(null, tempPath));
    expect(saved.metadata).toMatchObject({ prompt: 'A test image', steps: 20, seed: 42 });
    expect(JSON.parse(readFileSync(join(imagesDir, saved.filename.replace('.png', '.metadata.json')), 'utf8')))
      .toMatchObject(saved.metadata);
    expect(isPng(readFileSync(join(imagesDir, saved.filename)))).toBe(true);
  }, true));

  it('keeps the fixture until an abandoned writer rejects and settles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-gallery-owned-work-'));
    const owner = ownFixture(root);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const failure = new Error('controlled writer failure');
    const operation = owner.run(async () => {
      await gate;
      writeFileSync(join(root, 'late-write'), 'fixture');
      throw failure;
    });
    // Deterministically abandon the waiter, as a test deadline would. No sleep
    // or real timeout is needed to prove that the underlying writer stays owned.
    await expect(Promise.race([operation, Promise.reject(new Error('controlled timeout'))]))
      .rejects.toThrow('controlled timeout');
    let removed = false;
    const cleanup = owner.cleanup().then(() => { removed = true; });
    try {
      await Promise.resolve();
      expect(removed).toBe(false);
      expect(existsSync(root)).toBe(true);
      expect(() => owner.run(() => {})).toThrow('Gallery fixture is closing');
    } finally {
      release();
      await expect(operation).rejects.toBe(failure);
      await cleanup;
    }
    expect(removed).toBe(true);
    expect(existsSync(root)).toBe(false);
  });
});
