import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';
import { autoCleanGeneratedImage } from './imageClean.js';

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

  it('no-ops when enabled=false (file + sidecar untouched)', async () => {
    const beforeBytes = await readFile(pngPath);
    const beforeSidecar = await readFile(sidecarPath, 'utf-8');
    const result = await autoCleanGeneratedImage({
      enabled: false, pngPath, sidecarPath, mode: 'local',
    });
    expect(result.cleaned).toBe(false);
    expect((await readFile(pngPath)).equals(beforeBytes)).toBe(true);
    expect(await readFile(sidecarPath, 'utf-8')).toBe(beforeSidecar);
  });

  it('replaces the PNG in place and patches the sidecar when enabled=true', async () => {
    const beforeBytes = await readFile(pngPath);
    const result = await autoCleanGeneratedImage({
      enabled: true, pngPath, sidecarPath, mode: 'local',
    });
    expect(result.cleaned).toBe(true);

    // Bytes changed — sharp's median(3).sharpen() on a noisy fixture must
    // produce a different output than the source.
    const afterBytes = await readFile(pngPath);
    expect(afterBytes.equals(beforeBytes)).toBe(false);

    // Sidecar gets autoCleaned + cleanLevel + c2paStripped, AND keeps the
    // pre-existing fields (lineage preserved).
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf-8'));
    expect(sidecar.autoCleaned).toBe(true);
    expect(sidecar.cleanLevel).toBe('aggressive');
    expect(typeof sidecar.c2paStripped).toBe('boolean');
    expect(sidecar.prompt).toBe('a noisy fixture');
    expect(sidecar.seed).toBe(42);
  });

  it('still cleans the PNG when sidecarPath is null (external mode has no sidecar)', async () => {
    const beforeBytes = await readFile(pngPath);
    const result = await autoCleanGeneratedImage({
      enabled: true, pngPath, sidecarPath: null, mode: 'external',
    });
    expect(result.cleaned).toBe(true);
    expect((await readFile(pngPath)).equals(beforeBytes)).toBe(false);
  });

  it('returns cleaned=false (no throw) when the source file is missing', async () => {
    const result = await autoCleanGeneratedImage({
      enabled: true, pngPath: join(sandbox, 'does-not-exist.png'),
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
      enabled: true, pngPath: corruptPath, sidecarPath: null, mode: 'codex',
    });
    expect(result.cleaned).toBe(false);
    // The corrupt file stays exactly as-is — no half-written tmp left behind.
    expect(existsSync(corruptPath)).toBe(true);
  });

  it('cleans atomically: a temp file is not left behind on success', async () => {
    await autoCleanGeneratedImage({
      enabled: true, pngPath, sidecarPath, mode: 'codex',
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
      enabled: true, pngPath, sidecarPath, mode: 'local',
    });
    const after = await stat(pngPath);
    expect(after.size).toBeGreaterThan(0);
    // A median+sharpen pass on a small noisy fixture stays within an order of
    // magnitude of the original size — a wildly different size would suggest a
    // truncated write or format regression.
    expect(after.size).toBeLessThan(before.size * 10);
  });
});
