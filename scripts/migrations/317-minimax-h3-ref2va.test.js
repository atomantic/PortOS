import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration, { MINIMAX_H3_REF2VA_ENTRY } from './317-minimax-h3-ref2va.js';

describe('317-minimax-h3-ref2va migration', () => {
  let rootDir;

  beforeEach(() => {
    rootDir = join(tmpdir(), `portos-test-317-${Date.now()}`);
    mkdirSync(join(rootDir, 'data'), { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('adds the Ref2VA model and shipped-default marker', async () => {
    const initial = {
      video: { mlx: [{ id: 'ltx23_unified' }], cuda: [] },
      _shippedDefaults: { video: { mlx: ['ltx23_unified'] } },
    };
    writeFileSync(join(rootDir, 'data', 'media-models.json'), JSON.stringify(initial));

    await migration.up({ rootDir });

    const updated = JSON.parse(readFileSync(join(rootDir, 'data', 'media-models.json'), 'utf-8'));
    expect(updated.video.mlx).toContainEqual(MINIMAX_H3_REF2VA_ENTRY);
    expect(updated._shippedDefaults.video.mlx).toContain(MINIMAX_H3_REF2VA_ENTRY.id);
  });

  it('is idempotent and skips a missing registry', async () => {
    await migration.up({ rootDir });
    writeFileSync(join(rootDir, 'data', 'media-models.json'), JSON.stringify({ video: { mlx: [] } }));
    await migration.up({ rootDir });
    const firstPass = readFileSync(join(rootDir, 'data', 'media-models.json'), 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(join(rootDir, 'data', 'media-models.json'), 'utf-8')).toBe(firstPass);
  });

  it('does not resurrect an intentionally deleted shipped model on ledger replay', async () => {
    const path = join(rootDir, 'data', 'media-models.json');
    const initial = {
      video: { mlx: [{ id: 'ltx23_unified' }], cuda: [] },
      _shippedDefaults: {
        video: { mlx: ['ltx23_unified', MINIMAX_H3_REF2VA_ENTRY.id] },
      },
    };
    writeFileSync(path, JSON.stringify(initial));
    const before = readFileSync(path, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect(JSON.parse(before).video.mlx).not.toContainEqual(
      expect.objectContaining({ id: MINIMAX_H3_REF2VA_ENTRY.id }),
    );
  });
});
