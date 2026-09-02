import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import { mkdtemp, rm, readdir, readFile, unlink, writeFile } from 'fs/promises';
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
  // Mutate the shared PATHS object so both direct route reads and helper
  // closures such as resolveGalleryImage use the sandbox roots.
  actual.PATHS.images = imagesSandbox;
  actual.PATHS.imageRefs = refsSandbox;
  return { ...actual };
});

// These tests exercise multipart packing and edit-only validation, not host
// admission. Keep the fixture deterministic across macOS, Linux, and Windows
// runners by giving the media registry a synthetic capable host.
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
tryReadFile: vi.fn().mockResolvedValue(null),
  getSettings: vi.fn(async () => mockedSettings),
  settingsEvents: { on: () => {}, emit: () => {} },
}));

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(() => ({ jobId: 'multipart-job', position: 1, status: 'queued' })),
  attachSseClient: vi.fn(() => false),
  cancelJob: vi.fn(),
  listJobs: vi.fn(() => []),
}));

// /generate now records media.image.enqueue after enqueueJob (#5596). Mock the
// ledger so this packing suite does not trip the test data-root guard (500).
const recordUserAction = vi.hoisted(() => vi.fn(async () => ({ id: 'evt' })));
vi.mock('../services/userActions.js', () => ({ recordUserAction }));

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

async function postBody(app, path, body, contentType) {
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

async function postMultipart(app, path, parts) {
  const { body, contentType } = buildMultipart(parts);
  return postBody(app, path, body, contentType);
}

const postJson = (app, path, body) => postBody(
  app,
  path,
  JSON.stringify(body),
  'application/json',
);

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

  it('resolves a gallery image as a reference for a new conditioned render, not an init edit', async () => {
    mockedSettings = { imageGen: { mode: 'codex', codex: { enabled: true } } };
    await writeFile(join(imagesSandbox, 'prior-shot.png'), PNG_FIXTURE);

    const res = await postJson(app, '/api/image-gen/generate', {
      prompt: 'the same scout from a new camera angle',
      referenceImageFiles: ['prior-shot.png'],
      referenceStrengths: [0.4],
    });

    expect(res.status).toBe(200);
    const { params } = enqueueJob.mock.calls.at(-1)[0];
    expect(params.referenceImagePaths).toEqual([join(imagesSandbox, 'prior-shot.png')]);
    expect(params.referenceImageStrengths).toEqual([0.4]);
    expect(params.initImagePath).toBeUndefined();
    expect(params.referenceImageFiles).toBeUndefined();
  });

  it('returns the stable missing-reference code for a gallery image that no longer exists', async () => {
    mockedSettings = { imageGen: { mode: 'codex', codex: { enabled: true } } };

    const res = await postJson(app, '/api/image-gen/generate', {
      prompt: 'the same scout from a new camera angle',
      referenceImageFiles: ['missing-shot.png'],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REFERENCE_IMAGE_NOT_FOUND');
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('rejects more than four named and uploaded references before staging uploads', async () => {
    mockedSettings = { imageGen: { mode: 'codex', codex: { enabled: true } } };
    await Promise.all(['prior-a.png', 'prior-b.png']
      .map((filename) => writeFile(join(imagesSandbox, filename), PNG_FIXTURE)));

    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'the same scout from a new camera angle' },
      { name: 'referenceImageFiles', value: 'prior-a.png' },
      { name: 'referenceImageFiles', value: 'prior-b.png' },
      { name: 'referenceImage1', filename: 'a.png', contentType: 'image/png', value: PNG_FIXTURE },
      { name: 'referenceImage2', filename: 'b.png', contentType: 'image/png', value: PNG_FIXTURE },
      { name: 'referenceImage3', filename: 'c.png', contentType: 'image/png', value: PNG_FIXTURE },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOO_MANY_REFERENCE_IMAGES');
    expect(enqueueJob).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const refDirContents = await readdir(refsSandbox).catch(() => []);
    expect(refDirContents.filter((filename) => filename.startsWith('ref-'))).toHaveLength(0);
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

  // Edit-only models (Qwen-Image-Edit) require a source image. With an init
  // image uploaded, the route stages it and enqueues normally — the editOnly
  // gate only fires for text-only submissions.
  it('edit-only model WITH an uploaded init image enqueues with initImagePath set', async () => {
    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'make the sky purple' },
      { name: 'modelId', value: 'qwen-image-edit' },
      { name: 'initImage', filename: 'src.png', contentType: 'image/png', value: PNG_FIXTURE },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('queued');
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const params = enqueueJob.mock.calls[0][0].params;
    const { dir, name, ext } = parsePath(params.initImagePath);
    // Init uploads stage into PATHS.imageRefs (sibling of the gallery), NOT
    // PATHS.images — landing in the gallery dir surfaces them as duplicate
    // "(no prompt)" cards because listGallery() enumerates every .png there.
    expect(dir).toBe(refsSandbox);
    expect(name.startsWith('init-')).toBe(true);
    expect(ext).toBe('.png');
    // And no file leaked into the gallery dir.
    const imagesDirContents = await readdir(imagesSandbox);
    expect(imagesDirContents).toHaveLength(0);
  });

  // The editOnly gate must fire for a text-only submission to an edit-only
  // model even over multipart — no job is enqueued.
  it('edit-only model with NO init image returns 400 before enqueueing', async () => {
    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'make the sky purple' },
      { name: 'modelId', value: 'qwen-image-edit' },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IMAGE_GEN_EDIT_IMAGE_REQUIRED');
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  // Regression: a SINGLE selected LoRA arrives over multipart as a bare
  // string (multer only builds an array for 2+ repeated keys). coerceFormFields
  // must wrap it so Zod's `z.array(...)` accepts it — otherwise the request
  // 400s with "expected array, received string" + a bogus "<=8 characters"
  // (the .max(8) LoRA-count applied to the string's length).
  it('accepts a single LoRA (bare-string multipart fields) alongside an init image', async () => {
    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'single lora i2i' },
      { name: 'modelId', value: 'dev' },
      { name: 'loraFilenames', value: 'Hyperdetailed Colored Pencil.safetensors' },
      { name: 'loraScales', value: '0.9' },
      { name: 'initImage', filename: 'src.png', contentType: 'image/png', value: PNG_FIXTURE },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('queued');
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const params = enqueueJob.mock.calls[0][0].params;
    // The single scale coerced from string to number, not left as '0.9'.
    expect(params.loraScales).toEqual([0.9]);
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

  it('rejects refs on the external backend, which has no input-image wiring', async () => {
    // FLUX.2 model selected, but settings.imageGen.mode flips to the one
    // backend that can't consume `referenceImagePaths`. The gate must fire
    // BEFORE any file is staged into PATHS.imageRefs.
    mockedSettings = { imageGen: { mode: 'external' } };
    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'flux2 ref on wrong backend' },
      { name: 'modelId', value: 'flux2-klein-4b' },
      { name: 'referenceImage1', filename: 'a.png', contentType: 'image/png', value: PNG_FIXTURE },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.error || res.body).toMatch(/text-to-image only/i);
    expect(enqueueJob).not.toHaveBeenCalled();
    const refDirContents = await readdir(refsSandbox).catch(() => []);
    expect(refDirContents.filter((f) => f.startsWith('ref-'))).toHaveLength(0);
  });

  it.each(['codex', 'grok', 'agy'])('stages refs for the %s backend and threads the paths into the job', async (mode) => {
    // The cloud CLIs each feed reference images to their own image tool, so a
    // ref upload is honored rather than 400'd — the "local FLUX.2 only" gate
    // that used to reject these was the bug.
    mockedSettings = { imageGen: { mode, [mode]: { enabled: true } } };
    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'a fox in this style' },
      { name: 'referenceImage1', filename: 'a.png', contentType: 'image/png', value: PNG_FIXTURE },
      { name: 'referenceImage2', filename: 'b.png', contentType: 'image/png', value: PNG_FIXTURE },
    ]);

    expect(res.status).toBe(200);
    const { params } = enqueueJob.mock.calls.at(-1)[0];
    expect(params.mode).toBe(mode);
    expect(params.referenceImagePaths).toHaveLength(2);
    for (const p of params.referenceImagePaths) expect(p.startsWith(refsSandbox)).toBe(true);
  });

  it('rejects an upload for a DISABLED cloud backend before staging it', async () => {
    // The route throws the same disabledError a few steps later, but by then
    // the copy is in PATHS.imageRefs and the route's res.on('close') sweep
    // covers only multer temps — so a late rejection strands the staged file.
    mockedSettings = { imageGen: { mode: 'agy', agy: { enabled: false } } };
    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'a fox' },
      { name: 'referenceImage1', filename: 'a.png', contentType: 'image/png', value: PNG_FIXTURE },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.code || res.body.error).toMatch(/AGY_IMAGEGEN_DISABLED|disabled/i);
    expect(enqueueJob).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50));
    const refDirContents = await readdir(refsSandbox).catch(() => []);
    expect(refDirContents.filter((f) => f.startsWith('ref-'))).toHaveLength(0);
  });

  it('rejects more input images than the backend accepts instead of silently dropping them', async () => {
    // Agy's generate_image takes at most 3 images total. A direct API caller
    // sending 4 used to 200 while the provider quietly kept the first 3 — and
    // the dropped copies stayed on disk. The form caps its own slots, so this
    // guards the non-form callers.
    mockedSettings = { imageGen: { mode: 'agy', agy: { enabled: true } } };
    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'a fox' },
      { name: 'referenceImage1', filename: 'a.png', contentType: 'image/png', value: PNG_FIXTURE },
      { name: 'referenceImage2', filename: 'b.png', contentType: 'image/png', value: PNG_FIXTURE },
      { name: 'referenceImage3', filename: 'c.png', contentType: 'image/png', value: PNG_FIXTURE },
      { name: 'referenceImage4', filename: 'd.png', contentType: 'image/png', value: PNG_FIXTURE },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.code || res.body.error).toMatch(/TOO_MANY_INPUT_IMAGES|at most 3/i);
    expect(enqueueJob).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50));
    const refDirContents = await readdir(refsSandbox).catch(() => []);
    expect(refDirContents.filter((f) => f.startsWith('ref-'))).toHaveLength(0);
  });

  it('accepts exactly the backend cap — 3 references on agy with no init image', async () => {
    // The boundary the gate above must NOT reject.
    mockedSettings = { imageGen: { mode: 'agy', agy: { enabled: true } } };
    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'a fox' },
      { name: 'referenceImage1', filename: 'a.png', contentType: 'image/png', value: PNG_FIXTURE },
      { name: 'referenceImage2', filename: 'b.png', contentType: 'image/png', value: PNG_FIXTURE },
      { name: 'referenceImage3', filename: 'c.png', contentType: 'image/png', value: PNG_FIXTURE },
    ]);

    expect(res.status).toBe(200);
    expect(enqueueJob.mock.calls.at(-1)[0].params.referenceImagePaths).toHaveLength(3);
  });

  it('unlinks an already-staged ref when the prompt gate rejects a prompt-less agy render', async () => {
    // The one throw that can fire with an upload ALREADY copied into
    // PATHS.imageRefs: agy's tool lists `Prompt` as required, so a prompt-less
    // agy render carrying a reference gets past the pre-stage gates, stages the
    // file, and only then is rejected. Nothing downstream knows that file
    // exists — the route's res.on('close') sweep is wired from the return value
    // this throw prevents — so the throw itself has to unlink it.
    mockedSettings = { imageGen: { mode: 'agy', agy: { enabled: true } } };
    const tmpRoot = tmpdir();
    const beforeTmp = new Set((await readdir(tmpRoot).catch(() => []))
      .filter((f) => f.startsWith('upload-')));

    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'referenceImage1', filename: 'a.png', contentType: 'image/png', value: PNG_FIXTURE },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.error || res.body).toMatch(/prompt is required/i);
    expect(enqueueJob).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50));
    const refDirContents = await readdir(refsSandbox).catch(() => []);
    expect(refDirContents.filter((f) => f.startsWith('ref-'))).toHaveLength(0);
    const afterTmp = new Set((await readdir(tmpRoot).catch(() => []))
      .filter((f) => f.startsWith('upload-')));
    expect([...afterTmp].filter((f) => !beforeTmp.has(f))).toEqual([]);
  });

  it('deletes the multer temp when the gallery init image is missing', async () => {
    // Same family, smaller blast radius: `initImageFile` naming a nonexistent
    // gallery image throws BEFORE the reference loop stages anything, so only
    // the multer temps are at risk. Reachable on every cloud backend now that
    // they accept reference uploads.
    mockedSettings = { imageGen: { mode: 'codex', codex: { enabled: true } } };
    const tmpRoot = tmpdir();
    const before = new Set((await readdir(tmpRoot).catch(() => []))
      .filter((f) => f.startsWith('upload-')));

    const res = await postMultipart(app, '/api/image-gen/generate', [
      { name: 'prompt', value: 'a fox' },
      { name: 'initImageFile', value: 'does-not-exist.png' },
      { name: 'referenceImage1', filename: 'a.png', contentType: 'image/png', value: PNG_FIXTURE },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.error || res.body).toMatch(/init image not found/i);
    await new Promise((r) => setTimeout(r, 50));
    const after = new Set((await readdir(tmpRoot).catch(() => []))
      .filter((f) => f.startsWith('upload-')));
    expect([...after].filter((f) => !before.has(f))).toEqual([]);
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
