import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration from './336-fastmetal-download-size-names.js';

// The exact strings/values migration 314 and #5860 shipped. Spelled out rather
// than imported so the test would fail if a profile's `oldName` ever drifted off
// what installs actually carry — the whole guard rests on a byte-for-byte match.
const OLD_1_3B = 'FastMetal 1.3B QAD (~3.5 GB download, 8+ GB RAM, 3-step)';
const OLD_5B = 'FastMetal 5B QAD (~10 GB download, 16+ GB RAM, 3-step)';
const OLD_14B = 'FastMetal 14B QAD (~25 GB download, 36+ GB RAM, 3-step)';

const shippedRow = (id, name, repo, extra = {}) => ({ id, name, repo, runtime: 'fastvideo', ...extra });

const shippedRegistry = () => ({
  video: {
    mlx: [
      shippedRow('fastmetal_1_3b_qad', OLD_1_3B, 'FastVideo/FastMetal-1.3B-QAD'),
      shippedRow('fastmetal_5b_qad', OLD_5B, 'FastVideo/FastMetal-5B-QAD'),
      shippedRow('fastmetal_14b_qad', OLD_14B, 'FastVideo/FastMetal-14B-QAD'),
    ],
    cuda: [],
  },
});

describe('336-fastmetal-download-size-names migration', () => {
  let rootDir;
  let registryFile;

  beforeEach(() => {
    rootDir = join(tmpdir(), `portos-test-336-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    registryFile = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const write = (config) => writeFileSync(registryFile, JSON.stringify(config, null, 2));
  const read = () => JSON.parse(readFileSync(registryFile, 'utf-8'));
  const rowsById = () => Object.fromEntries(read().video.mlx.map((m) => [m.id, m]));

  it('skips gracefully when media-models.json does not exist', async () => {
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });

  it('rewrites all three shipped names onto the size the download actually pulls', async () => {
    write(shippedRegistry());

    await migration.up({ rootDir });

    const rows = rowsById();
    expect(rows.fastmetal_1_3b_qad.name).toBe('FastMetal 1.3B QAD (~13.4 GB download, 8+ GB RAM, 3-step)');
    expect(rows.fastmetal_5b_qad.name).toBe('FastMetal 5B QAD (~19.5 GB download, 16+ GB RAM, 3-step)');
    expect(rows.fastmetal_14b_qad.name).toBe('FastMetal 14B QAD (~27.1 GB download, 36+ GB RAM, 3-step)');
  });

  it('narrows only the 14B row off its duplicated ema/ DiT', async () => {
    write(shippedRegistry());

    await migration.up({ rootDir });

    const rows = rowsById();
    expect(rows.fastmetal_1_3b_qad.repoFiles).toBeUndefined();
    expect(rows.fastmetal_5b_qad.repoFiles).toBeUndefined();
    // The root DiT is in; the `ema/` copy of it — 14.14 GB the entry script
    // never loads — is what the narrowing exists to drop.
    expect(rows.fastmetal_14b_qad.repoFiles).toContain('mlx_dit.safetensors');
    expect(rows.fastmetal_14b_qad.repoFiles.some((f) => f.startsWith('ema/'))).toBe(false);
    // The pipeline's other components must survive the narrowing, or the
    // download completes and the render fails on a missing text encoder.
    expect(rows.fastmetal_14b_qad.repoFiles).toEqual(expect.arrayContaining([
      'model_index.json',
      'text_encoder/model-00005-of-00005.safetensors',
      'vae/diffusion_pytorch_model.safetensors',
    ]));
  });

  it('repairs a stale persisted disclosure size from either shipped generation', async () => {
    const config = shippedRegistry();
    // Pre-#5860: the DiT-only figure. Post-#5860: the whole-snapshot figure the
    // 14B row no longer pulls now that `ema/` is excluded.
    config.video.mlx[0].disclosure = { estimatedDownloadGb: 3.5, reviewedAt: '2026-08-01' };
    config.video.mlx[2].disclosure = { estimatedDownloadGb: 42.3, reviewedAt: '2026-09-02' };
    write(config);

    await migration.up({ rootDir });

    const rows = rowsById();
    expect(rows.fastmetal_1_3b_qad.disclosure.estimatedDownloadGb).toBe(13.4);
    expect(rows.fastmetal_14b_qad.disclosure.estimatedDownloadGb).toBe(27.1);
    // Everything else in the block is the user's/shipped provenance — untouched.
    expect(rows.fastmetal_1_3b_qad.disclosure.reviewedAt).toBe('2026-08-01');
  });

  it('leaves a renamed, re-pointed, pre-narrowed or hand-estimated row alone', async () => {
    write({
      video: {
        mlx: [
          shippedRow('fastmetal_1_3b_qad', 'My tiny video model', 'FastVideo/FastMetal-1.3B-QAD'),
          shippedRow('fastmetal_5b_qad', OLD_5B, 'example/FastMetal-5B-fork'),
          shippedRow('fastmetal_14b_qad', OLD_14B, 'FastVideo/FastMetal-14B-QAD', {
            repoFiles: ['mlx_dit.safetensors'],
            disclosure: { estimatedDownloadGb: 31.2 },
          }),
        ],
        cuda: [],
      },
    });

    await migration.up({ rootDir });

    const rows = rowsById();
    expect(rows.fastmetal_1_3b_qad.name).toBe('My tiny video model');
    // A forked repo gets nothing: PortOS has not measured what it pulls.
    expect(rows.fastmetal_5b_qad.name).toBe(OLD_5B);
    expect(rows.fastmetal_5b_qad.repoFiles).toBeUndefined();
    // The name is still the untouched shipped string, so it IS corrected — but
    // the owner's own narrowing and estimate are preserved.
    expect(rows.fastmetal_14b_qad.name).toBe('FastMetal 14B QAD (~27.1 GB download, 36+ GB RAM, 3-step)');
    expect(rows.fastmetal_14b_qad.repoFiles).toEqual(['mlx_dit.safetensors']);
    expect(rows.fastmetal_14b_qad.disclosure.estimatedDownloadGb).toBe(31.2);
  });

  it('is idempotent — a second run rewrites nothing', async () => {
    write(shippedRegistry());
    await migration.up({ rootDir });
    const afterFirst = readFileSync(registryFile, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(registryFile, 'utf-8')).toBe(afterFirst);
  });

  it('skips a row the user deleted without touching its siblings', async () => {
    const config = shippedRegistry();
    config.video.mlx = config.video.mlx.filter((m) => m.id !== 'fastmetal_5b_qad');
    write(config);

    await migration.up({ rootDir });

    const rows = rowsById();
    expect(rows.fastmetal_5b_qad).toBeUndefined();
    expect(rows.fastmetal_14b_qad.name).toBe('FastMetal 14B QAD (~27.1 GB download, 36+ GB RAM, 3-step)');
  });
});
