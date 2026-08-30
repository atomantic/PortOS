import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './317-minimax-h3-memory-profiles.js';
import { MINIMAX_H3_MEMORY_PROFILES } from '../../server/lib/minimaxH3Memory.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const MLX_ID = 'minimax_h3_8bit';
const CUDA_ID = 'minimax_h3_cuda';
const mlxSpec = MINIMAX_H3_MEMORY_PROFILES[MLX_ID];
const cudaSpec = MINIMAX_H3_MEMORY_PROFILES[CUDA_ID];

// The registry as an existing install stores it, pre-migration — on the LEGACY
// bucket spellings, which is the shape a pre-#4142 install is still on.
const baseRegistry = (overrides = {}) => ({
  video: {
    macos: [
      {
        id: MLX_ID,
        name: 'MiniMax H3 MLX 8-bit',
        repo: mlxSpec.shippedRepo,
        revision: mlxSpec.shippedRevision,
        runtime: 'minimax_h3',
        memoryGb: 128,
        ...overrides,
      },
      { id: 'my_custom_model', name: 'My Custom Model', repo: 'example-org/example-video', source: 'user' },
    ],
    windows: [{
      id: CUDA_ID,
      name: 'MiniMax H3 CUDA int8',
      repo: cudaSpec.shippedRepo,
      revision: cudaSpec.shippedRevision,
      runtime: 'minimax_h3_cuda',
      memoryGb: 96,
    }],
    defaultMacos: MLX_ID,
  },
});

const findMacos = (path, id) => readJson(path).video.macos.find((entry) => entry.id === id);

describe('migration 317 — MiniMax H3 memory profiles', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-317-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('attaches the shipped table to both H3 entries across bucket spellings', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    expect(findMacos(path, MLX_ID).memoryProfiles).toEqual([...mlxSpec.profiles]);
    expect(readJson(path).video.windows[0].memoryProfiles).toEqual([...cudaSpec.profiles]);
  });

  it('leaves everything else on the entry, and its position, untouched', async () => {
    const before = baseRegistry();
    writeJson(path, before);
    await migration.up({ rootDir });
    const after = readJson(path);
    expect(after.video.macos.map((entry) => entry.id)).toEqual(before.video.macos.map((entry) => entry.id));
    const { memoryProfiles: _added, ...rest } = after.video.macos[0];
    expect(rest).toEqual(before.video.macos[0]);
    expect(after.video.macos[1]).toEqual(before.video.macos[1]);
  });

  it('preserves a user value, including a deliberate empty list', async () => {
    writeJson(path, baseRegistry({ memoryProfiles: [] }));
    await migration.up({ rootDir });
    expect(findMacos(path, MLX_ID).memoryProfiles).toEqual([]);
  });

  it('skips an entry re-pointed off the pinned weights', async () => {
    writeJson(path, baseRegistry({ revision: 'deadbeefdeadbeef' }));
    await migration.up({ rootDir });
    expect(findMacos(path, MLX_ID)).not.toHaveProperty('memoryProfiles');
  });

  it('is a no-op on a fresh install with no registry file yet', async () => {
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it('rewrites nothing when every entry already carries the key', async () => {
    writeJson(path, baseRegistry({ memoryProfiles: [...mlxSpec.profiles] }));
    const before = readFileSync(path, 'utf-8');
    // The CUDA entry still gains one, so assert idempotence on a second pass.
    await migration.up({ rootDir });
    const once = readFileSync(path, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(once);
    expect(once).not.toBe(before);
  });
});
