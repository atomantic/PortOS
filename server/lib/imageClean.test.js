import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';
import { autoCleanGeneratedImage, stripPngC2PAChunk } from './imageClean.js';

let sandbox;
let pngFixture;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'portos-autoclean-'));
  // Noisy 32×32 RGB — large enough that sharp's median+sharpen passes don't
  // produce zero-byte output, small enough that tests stay fast.
  const raw = Buffer.alloc(32 * 32 * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 73 + 11) % 256;
  pngFixture = await sharp(raw, { raw: { width: 32, height: 32, channels: 3 } })
    .png()
    .toBuffer();
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('autoCleanGeneratedImage', () => {
  let pngPath;
  let sidecarPath;

  beforeEach(async () => {
    // Unique filenames per test so they don't see each other's leftovers.
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pngPath = join(sandbox, `${id}.png`);
    sidecarPath = join(sandbox, `${id}.metadata.json`);
    await writeFile(pngPath, pngFixture);
    await writeFile(sidecarPath, JSON.stringify({
      prompt: 'a noisy fixture', seed: 42, modelId: 'fixture',
    }));
  });

  it('no-ops when both flags are false (file + sidecar untouched)', async () => {
    const beforeBytes = await readFile(pngPath);
    const beforeSidecar = await readFile(sidecarPath, 'utf-8');
    const result = await autoCleanGeneratedImage({
      cleanC2PA: false, denoise: false, pngPath, sidecarPath, mode: 'local',
    });
    expect(result.cleaned).toBe(false);
    expect((await readFile(pngPath)).equals(beforeBytes)).toBe(true);
    expect(await readFile(sidecarPath, 'utf-8')).toBe(beforeSidecar);
  });

  it('cleanC2PA=true on local/external mode short-circuits without reading the file (hot-path fast-path)', async () => {
    // Local FLUX + external SD-API never emit caBX chunks. With cleanC2PA
    // defaulting to true, every batch render would otherwise pay a wasted
    // readFile + chunk walk. The mode gate skips both when denoise is off.
    const beforeBytes = await readFile(pngPath);
    const result = await autoCleanGeneratedImage({
      cleanC2PA: true, denoise: false, pngPath, sidecarPath, mode: 'local',
    });
    expect(result.cleaned).toBe(false);
    expect((await readFile(pngPath)).equals(beforeBytes)).toBe(true);

    // External SD-API takes the same short-circuit.
    const resultExt = await autoCleanGeneratedImage({
      cleanC2PA: true, denoise: false, pngPath, sidecarPath, mode: 'external',
    });
    expect(resultExt.cleaned).toBe(false);
  });

  it('denoise on local/external still runs (only the cleanC2PA-only path is mode-gated)', async () => {
    // The gate only skips the cleanC2PA-only case — denoise=true forces the
    // pixel pass through regardless of mode, because the user explicitly
    // asked for it.
    const result = await autoCleanGeneratedImage({
      cleanC2PA: false, denoise: true, pngPath, sidecarPath, mode: 'local',
    });
    expect(result.cleaned).toBe(true);
  });

  it('no-ops with cleanC2PA=true on a PNG that has no caBX chunk (pixels untouched)', async () => {
    // The fixture has no caBX chunk, so the lossless strip path bails out
    // and leaves the file as-is — proves the lossless path doesn't
    // re-encode "just in case" and corrupt clean PNGs.
    const beforeBytes = await readFile(pngPath);
    const result = await autoCleanGeneratedImage({
      cleanC2PA: true, denoise: false, pngPath, sidecarPath, mode: 'codex',
    });
    expect(result.cleaned).toBe(false);
    expect((await readFile(pngPath)).equals(beforeBytes)).toBe(true);
  });

  it('replaces the PNG in place and patches the sidecar when enabled=true', async () => {
    const beforeBytes = await readFile(pngPath);
    const result = await autoCleanGeneratedImage({
      denoise: true, pngPath, sidecarPath, mode: 'local',
    });
    expect(result.cleaned).toBe(true);

    // Bytes changed — sharp's median(3).sharpen() on a noisy fixture must
    // produce a different output than the source.
    const afterBytes = await readFile(pngPath);
    expect(afterBytes.equals(beforeBytes)).toBe(false);

    // Sidecar gets autoCleaned + cleanLevel + c2paStripped + denoised, AND
    // keeps the pre-existing fields (lineage preserved).
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf-8'));
    expect(sidecar.autoCleaned).toBe(true);
    expect(sidecar.denoised).toBe(true);
    expect(sidecar.cleanLevel).toBe('aggressive');
    expect(typeof sidecar.c2paStripped).toBe('boolean');
    expect(sidecar.prompt).toBe('a noisy fixture');
    expect(sidecar.seed).toBe(42);
  });

  it('cleanC2PA=true with a real caBX chunk strips losslessly (sidecar marks metadata level)', async () => {
    // Inject a synthetic caBX chunk before IEND to simulate a gpt-image render.
    const png = await readFile(pngPath);
    const caBXData = Buffer.alloc(120, 0xCA);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(caBXData.length, 0);
    const chunk = Buffer.concat([length, Buffer.from('caBX', 'ascii'), caBXData, Buffer.alloc(4)]);
    const polluted = Buffer.concat([png.subarray(0, png.length - 12), chunk, png.subarray(png.length - 12)]);
    await writeFile(pngPath, polluted);

    const result = await autoCleanGeneratedImage({
      cleanC2PA: true, denoise: false, pngPath, sidecarPath, mode: 'codex',
    });
    expect(result.cleaned).toBe(true);
    expect(result.c2paStripped).toBe(true);
    expect(result.denoised).toBe(false);

    // Output bytes equal the ORIGINAL fixture — proves the strip is lossless.
    const after = await readFile(pngPath);
    expect(after.equals(png)).toBe(true);

    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf-8'));
    expect(sidecar.cleanLevel).toBe('metadata');
    expect(sidecar.denoised).toBe(false);
    expect(sidecar.c2paStripped).toBe(true);
  });

  it('still cleans the PNG when sidecarPath is null (external mode has no sidecar)', async () => {
    const beforeBytes = await readFile(pngPath);
    const result = await autoCleanGeneratedImage({
      denoise: true, pngPath, sidecarPath: null, mode: 'external',
    });
    expect(result.cleaned).toBe(true);
    expect((await readFile(pngPath)).equals(beforeBytes)).toBe(false);
  });

  it('returns cleaned=false (no throw) when the source file is missing', async () => {
    const result = await autoCleanGeneratedImage({
      denoise: true, pngPath: join(sandbox, 'does-not-exist.png'),
      sidecarPath: null, mode: 'local',
    });
    expect(result.cleaned).toBe(false);
  });

  it('returns cleaned=false (no throw) when the source file is corrupt', async () => {
    const corruptPath = join(sandbox, 'corrupt.png');
    // PNG magic byte followed by garbage — passes detectFormat but breaks sharp.
    await writeFile(corruptPath, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64),
    ]));
    const result = await autoCleanGeneratedImage({
      denoise: true, pngPath: corruptPath, sidecarPath: null, mode: 'codex',
    });
    expect(result.cleaned).toBe(false);
    // The corrupt file stays exactly as-is — no half-written tmp left behind.
    expect(existsSync(corruptPath)).toBe(true);
  });

  it('cleans atomically: a temp file is not left behind on success', async () => {
    await autoCleanGeneratedImage({
      denoise: true, pngPath, sidecarPath, mode: 'codex',
    });
    // Look for any orphaned `.tmp` files in the sandbox — the rename should
    // have moved the temp over the original.
    const { readdir } = await import('fs/promises');
    const entries = await readdir(sandbox);
    const tmps = entries.filter((n) => n.endsWith('.tmp'));
    expect(tmps).toEqual([]);
  });

  it('preserves PNG size sanity (output is non-zero and roughly the same magnitude)', async () => {
    const before = await stat(pngPath);
    await autoCleanGeneratedImage({
      denoise: true, pngPath, sidecarPath, mode: 'local',
    });
    const after = await stat(pngPath);
    expect(after.size).toBeGreaterThan(0);
    // A median+sharpen pass on a small noisy fixture stays within an order of
    // magnitude of the original size — a wildly different size would suggest a
    // truncated write or format regression.
    expect(after.size).toBeLessThan(before.size * 10);
  });
});

// Manually-constructed PNG chunk: `length(4) + type(4) + data(length) + crc(4)`.
// Helper so we can splice a synthetic caBX chunk into the fixture before IEND.
function makePngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  // CRC value isn't validated by stripPngC2PAChunk (it walks structurally, not
  // semantically), so use a zero CRC to keep the fixture builder simple.
  const crc = Buffer.alloc(4);
  return Buffer.concat([length, typeBytes, data, crc]);
}

// Inject a chunk into the PNG fixture just before its IEND chunk. IEND is the
// last 12 bytes of a well-formed PNG, so splicing at length-12 produces a
// valid chunk stream the walker can traverse end-to-end.
function injectChunkBeforeIEND(png, chunk) {
  return Buffer.concat([png.subarray(0, png.length - 12), chunk, png.subarray(png.length - 12)]);
}

describe('stripPngC2PAChunk', () => {
  it('returns the input untouched when no caBX chunk is present', () => {
    const result = stripPngC2PAChunk(pngFixture);
    expect(result.stripped).toBe(false);
    expect(result.data).toBe(pngFixture);
    expect(result.sizeBefore).toBe(pngFixture.length);
    expect(result.sizeAfter).toBe(pngFixture.length);
  });

  it('emits a NEW buffer that excludes the caBX chunk but keeps pixels byte-identical', async () => {
    // Splice a synthetic 100-byte caBX chunk before IEND.
    const caBXData = Buffer.alloc(100, 0xCA);
    const caBXChunk = makePngChunk('caBX', caBXData);
    const polluted = injectChunkBeforeIEND(pngFixture, caBXChunk);
    expect(polluted.length).toBe(pngFixture.length + caBXChunk.length);

    const result = stripPngC2PAChunk(polluted);
    expect(result.stripped).toBe(true);
    expect(result.sizeBefore).toBe(polluted.length);
    expect(result.sizeAfter).toBe(pngFixture.length);
    // The stripped buffer must equal the original fixture byte-for-byte —
    // proves the operation is pixel-identical (no re-encode).
    expect(result.data.equals(pngFixture)).toBe(true);
  });

  it('drops every caBX chunk when multiple are present (defensive against duplicates)', () => {
    const c1 = makePngChunk('caBX', Buffer.alloc(40, 0x01));
    const c2 = makePngChunk('caBX', Buffer.alloc(60, 0x02));
    const polluted = injectChunkBeforeIEND(injectChunkBeforeIEND(pngFixture, c1), c2);
    const result = stripPngC2PAChunk(polluted);
    expect(result.stripped).toBe(true);
    expect(result.data.equals(pngFixture)).toBe(true);
  });

  it('passes through unchanged for non-PNG input (JPEG/WebP/garbage)', () => {
    // JPEG-ish signature: 0xFF 0xD8 0xFF followed by some random bytes.
    const fakeJpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(100, 0x99)]);
    expect(stripPngC2PAChunk(fakeJpeg).stripped).toBe(false);
    expect(stripPngC2PAChunk(fakeJpeg).data).toBe(fakeJpeg);

    expect(stripPngC2PAChunk(Buffer.from('not even close')).stripped).toBe(false);
    expect(stripPngC2PAChunk(Buffer.alloc(0)).stripped).toBe(false);
  });

  it('passes through unchanged for malformed PNG (truncated, no IEND)', () => {
    // Real PNG header but chopped before IEND — the walker bails on missing IEND.
    const truncated = pngFixture.subarray(0, pngFixture.length - 12);
    const result = stripPngC2PAChunk(truncated);
    expect(result.stripped).toBe(false);
    expect(result.data).toBe(truncated);
  });

  it('passes through unchanged on non-buffer input', () => {
    expect(stripPngC2PAChunk(null).stripped).toBe(false);
    expect(stripPngC2PAChunk(undefined).stripped).toBe(false);
    expect(stripPngC2PAChunk('a string').stripped).toBe(false);
  });
});
