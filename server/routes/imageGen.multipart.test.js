import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { mkdtemp, rm, readdir, readFile, unlink } from 'fs/promises';
import { join, parse as parsePath } from 'path';
import { tmpdir } from 'os';
import { errorMiddleware } from '../lib/errorHandler.js';

// Sandbox PATHS.images + PATHS.imageRefs so the route can copyFile() to real
// directories without touching the repo's data/. Installed BEFORE the route
// module imports fileUtils.js — hence the dynamic import below.
let imagesSandbox;
let refsSandbox;

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...actual,
    get PATHS() {
      return { ...actual.PATHS, images: imagesSandbox, imageRefs: refsSandbox };
    },
  };
});

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

// Local-mode test: route enqueues into the queue rather than running the
// renderer; assert the params landing in enqueueJob carry the packed reference
// arrays in submit order.
// `getSettings` is mocked per-test so we can flip the effective backend
// (`local` vs. `external` vs. `codex`) and exercise the route's mode-aware
// reference-image gate. Default: `mode: 'local'` with a fake pythonPath.
let mockedSettings = { imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } };
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => mockedSettings),
}));

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(() => ({ jobId: 'multipart-job', position: 1, status: 'queued' })),
  attachSseClient: vi.fn(() => false),
  cancelJob: vi.fn(),
  listJobs: vi.fn(() => []),
}));

let imageGenRoutes;
let enqueueJob;

// Minimal valid PNG (8×8 white) — the route trusts the validated mimetype,
// not the pixel data, so any PNG-shaped bytes work for verifying the copy
// + pack path.
const PNG_FIXTURE = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000080000000808060000' +
  '00c40fbe8b0000001c4944415478da636060606060606060606060606060' +
  '0000000600014cbc20a30000000049454e44ae426082',
  'hex',
);

beforeAll(async () => {
  imagesSandbox = await mkdtemp(join(tmpdir(), 'portos-imagegen-multipart-images-'));
  refsSandbox = await mkdtemp(join(tmpdir(), 'portos-imagegen-multipart-refs-'));
  ({ default: imageGenRoutes } = await import('./imageGen.js'));
  ({ enqueueJob } = await import('../services/mediaJobQueue/index.js'));
});

afterAll(async () => {
  await rm(imagesSandbox, { recursive: true, force: true });
  await rm(refsSandbox, { recursive: true, force: true });
});

// Build a multipart/form-data body buffer. Each part is { name, filename?,
// contentType?, value: string|Buffer }. Returns the body + the Content-Type
// header (boundary baked in).
const BOUNDARY = '----PortOSMultipartTestBoundary';
const CRLF = '\r\n';
function buildMultipart(parts) {
  const sections = parts.map((p) => {
    let header = `--${BOUNDARY}${CRLF}Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename) header += `; filename="${p.filename}"`;
    header += CRLF;
    if (p.contentType) header += `Content-Type: ${p.contentType}${CRLF}`;
    header += CRLF;
    const value = Buffer.isBuffer(p.value) ? p.value : Buffer.from(String(p.value));
    return Buffer.concat([Buffer.from(header), value, Buffer.from(CRLF)]);
  });
  return {
    body: Buffer.concat([...sections, Buffer.from(`--${BOUNDARY}--${CRLF}`)]),
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
  };
}

async function postMultipart(app, path, parts) {
  const { body, contentType } = buildMultipart(parts);
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      body,
      headers: { 'content-type': contentType },
    });
    const text = await res.text();
    const ct = res.headers.get('content-type') || '';
    return {
      status: res.status,
      body: text && ct.includes('application/json') ? JSON.parse(text) : text,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('POST /api/image-gen/generate — multipart reference-image packing', () => {
  let app;

  beforeEach(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/image-gen', imageGenRoutes);
    app.use(errorMiddleware);
    vi.clearAllMocks();
    // Reset the mode-mock to the default `local` so a previous test that
    // flipped it to `external`/`codex` doesn't bleed into the next one.
    mockedSettings = { imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } };
    // Empty both sandbox dirs so each test's file-presence assertions reflect
    // ONLY that test's uploads — leftover ref-* files from prior tests would
    // make the "gate rejects before copy" test see stale data.
    for (const dir of [imagesSandbox, refsSandbox]) {
      const existing = await readdir(dir).catch(() => []);
      await Promise.all(existing.map((f) => unlink(join(dir, f)).catch(() => {})));
    }
  });

  it('packs populated reference slots into referenceImagePaths in submit order with parallel strengths', async () => {
    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'multi-ref test' },
      { name: 'modelId', value: 'flux2-klein-4b' },
      { name: 'referenceImage1', filename: 'a.png', contentType: 'image/png', value: PNG_FIXTURE },
      { name: 'referenceImage2', filename: 'b.png', contentType: 'image/png', value: PNG_FIXTURE },
      { name: 'referenceStrengths', value: '0.8' },
      { name: 'referenceStrengths', value: '0.3' },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('queued');
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const params = enqueueJob.mock.calls[0][0].params;
    // Both refs landed in PATHS.imageRefs (sandboxed) with submit-order positions.
    // Compare via path utilities rather than building a regex from the sandbox
    // path — temp paths on Windows (backslashes) and any sandbox path containing
    // regex metacharacters (`.`, `(`, `[`) would otherwise be interpreted by
    // the regex engine instead of matched literally.
    expect(params.referenceImagePaths).toHaveLength(2);
    for (const refPath of params.referenceImagePaths) {
      const { dir, name, ext } = parsePath(refPath);
      expect(dir).toBe(refsSandbox);
      expect(name.startsWith('ref-')).toBe(true);
      expect(ext).toBe('.png');
    }
    expect(params.referenceImageStrengths).toEqual([0.8, 0.3]);
    // Files were actually copied (gallery enumeration would never see them
    // because they're outside PATHS.images).
    const refDirContents = await readdir(refsSandbox);
    expect(refDirContents.filter((f) => f.startsWith('ref-'))).toHaveLength(2);
    // Sanity: the copies carry the PNG fixture bytes (route trusts mimetype but
    // writes the raw upload through, so the bytes round-trip).
    const firstRefBytes = await readFile(params.referenceImagePaths[0]);
    expect(firstRefBytes.equals(PNG_FIXTURE)).toBe(true);
    // References must NOT land in PATHS.images — that would surface them in
    // the gallery's flat .png enumeration.
    const imagesDirContents = await readdir(imagesSandbox);
    expect(imagesDirContents.filter((f) => f.startsWith('ref-'))).toHaveLength(0);
  });

  it('packs only the filled slots (gaps in the slot numbering collapse to a packed array)', async () => {
    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'sparse multi-ref' },
      { name: 'modelId', value: 'flux2-klein-4b' },
      // Slot 1 empty, slots 2 + 4 filled, slot 3 empty.
      { name: 'referenceImage2', filename: 'b.png', contentType: 'image/png', value: PNG_FIXTURE },
      { name: 'referenceImage4', filename: 'd.png', contentType: 'image/png', value: PNG_FIXTURE },
      // Two strengths to match the two filled slots, in slot order.
      { name: 'referenceStrengths', value: '0.6' },
      { name: 'referenceStrengths', value: '0.9' },
    ]);

    expect(res.status).toBe(200);
    const params = enqueueJob.mock.calls[0][0].params;
    expect(params.referenceImagePaths).toHaveLength(2);
    expect(params.referenceImageStrengths).toEqual([0.6, 0.9]);
  });

  it('defaults missing strengths to 1.0 (full influence)', async () => {
    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'no-strengths multi-ref' },
      { name: 'modelId', value: 'flux2-klein-4b' },
      { name: 'referenceImage1', filename: 'a.png', contentType: 'image/png', value: PNG_FIXTURE },
      // No referenceStrengths sent.
    ]);

    expect(res.status).toBe(200);
    const params = enqueueJob.mock.calls[0][0].params;
    expect(params.referenceImagePaths).toHaveLength(1);
    expect(params.referenceImageStrengths).toEqual([1.0]);
  });

  it('rejects refs uploaded for a non-FLUX.2 model before any file is copied', async () => {
    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'wrong-model ref' },
      // `dev` is the default mflux Flux.1 model — NOT FLUX.2.
      { name: 'modelId', value: 'dev' },
      { name: 'referenceImage1', filename: 'a.png', contentType: 'image/png', value: PNG_FIXTURE },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.error || res.body).toMatch(/FLUX\.2/i);
    expect(enqueueJob).not.toHaveBeenCalled();
    // The upload was never persisted to PATHS.imageRefs (no orphan files left
    // behind by a request the route already knows it can't honor).
    const refDirContents = await readdir(refsSandbox).catch(() => []);
    expect(refDirContents.filter((f) => f.startsWith('ref-'))).toHaveLength(0);
  });

  it('rejects refs when the effective backend is not local (codex/external) — even with a FLUX.2 modelId', async () => {
    // FLUX.2 model selected, but settings.imageGen.mode flips to a backend
    // that doesn't consume `referenceImagePaths`. The gate must fire BEFORE
    // any file is staged into PATHS.imageRefs.
    mockedSettings = { imageGen: { mode: 'external' } };
    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'flux2 ref on wrong backend' },
      { name: 'modelId', value: 'flux2-klein-4b' },
      { name: 'referenceImage1', filename: 'a.png', contentType: 'image/png', value: PNG_FIXTURE },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.error || res.body).toMatch(/local/i);
    expect(enqueueJob).not.toHaveBeenCalled();
    const refDirContents = await readdir(refsSandbox).catch(() => []);
    expect(refDirContents.filter((f) => f.startsWith('ref-'))).toHaveLength(0);
  });

  it('rejecting a non-FLUX.2 ref upload deletes the multer-staged tmp file (no os.tmpdir leak)', async () => {
    // Snapshot the tmpdir's `upload-*` entries before and after the request.
    // The multipart parser writes uploads as `upload-<uuid><ext>`, so the
    // post-cleanup diff must be empty for the rejected request.
    const tmpRoot = tmpdir();
    const before = new Set((await readdir(tmpRoot).catch(() => []))
      .filter((f) => f.startsWith('upload-')));

    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'wrong-model ref tmp-cleanup' },
      { name: 'modelId', value: 'dev' },
      { name: 'referenceImage1', filename: 'a.png', contentType: 'image/png', value: PNG_FIXTURE },
    ]);
    expect(res.status).toBe(400);

    // unlink() is fire-and-forget — give it a microtask tick to settle so the
    // post-snapshot reflects the cleanup.
    await new Promise((r) => setTimeout(r, 50));
    const after = new Set((await readdir(tmpRoot).catch(() => []))
      .filter((f) => f.startsWith('upload-')));
    // Any `upload-*` entry that's new vs. the pre-request snapshot is a leak.
    const leaked = [...after].filter((f) => !before.has(f));
    expect(leaked).toEqual([]);
  });
});
