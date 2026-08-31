import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration from './314-fastvideo-mlx-models.js';

describe('314-fastvideo-mlx-models migration', () => {
  let rootDir;

  beforeEach(() => {
    rootDir = join(tmpdir(), `portos-test-314-${Date.now()}`);
    mkdirSync(join(rootDir, 'data'), { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('skips gracefully when media-models.json does not exist', async () => {
    await migration.up({ rootDir });
    expect(true).toBe(true);
  });

  it('adds FastMetal models to an existing MLX registry', async () => {
    const initial = {
      video: {
        mlx: [
          { id: 'ltx23_unified', name: 'LTX-2.3' },
        ],
        cuda: [],
      },
      _shippedDefaults: {
        video: {
          mlx: ['ltx23_unified'],
        },
      },
    };
    writeFileSync(join(rootDir, 'data', 'media-models.json'), JSON.stringify(initial, null, 2));

    await migration.up({ rootDir });

    const updated = JSON.parse(readFileSync(join(rootDir, 'data', 'media-models.json'), 'utf-8'));
    const ids = updated.video.mlx.map((m) => m.id);
    expect(ids).toContain('fastmetal_1_3b_qad');
    expect(ids).toContain('fastmetal_5b_qad');
    expect(ids).toContain('fastmetal_14b_qad');

    const shipped = updated._shippedDefaults.video.mlx;
    expect(shipped).toContain('fastmetal_1_3b_qad');
    expect(shipped).toContain('fastmetal_5b_qad');
    expect(shipped).toContain('fastmetal_14b_qad');
  });

  it('is idempotent when run multiple times', async () => {
    const initial = {
      video: {
        mlx: [
          { id: 'ltx23_unified', name: 'LTX-2.3' },
        ],
      },
    };
    writeFileSync(join(rootDir, 'data', 'media-models.json'), JSON.stringify(initial, null, 2));

    await migration.up({ rootDir });
    const firstPass = readFileSync(join(rootDir, 'data', 'media-models.json'), 'utf-8');

    await migration.up({ rootDir });
    const secondPass = readFileSync(join(rootDir, 'data', 'media-models.json'), 'utf-8');

    expect(firstPass).toBe(secondPass);
  });
});
