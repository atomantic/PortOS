import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { MODEL_ROOT_KINDS, modelRootForBackend, modelRootPath, resolveModelRoots, storeModelRootIds } from './modelRoots.js';
import { MODEL_INVENTORY_BACKENDS, MODEL_STORE_BACKENDS } from './modelInventory.js';
import { FASTVIDEO_MLX_CHECKPOINT_DIR } from '../services/videoGen/runtimes.js';

const ENV_KEYS = ['MTPLX_HOME', 'HY3DGEN_MODELS', 'HF_XET_CACHE', 'HF_HOME', 'XDG_CACHE_HOME', 'PIXIE_FORGE_HOME', 'SLOTSTREAM_MODEL_DIR', 'PORTOS_MODELS_HOME', 'PORTOS_REPO_MODELS_DIR'];

let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('model root registry', () => {
  it('declares each root once, with a known kind and an owner', () => {
    const roots = resolveModelRoots();
    expect(new Set(roots.map((root) => root.id)).size).toBe(roots.length);
    for (const root of roots) {
      expect(Object.keys(MODEL_ROOT_KINDS)).toContain(root.kind);
      expect(root.owner).toBeTruthy();
      expect(root.path).toBeTruthy();
    }
    expect(roots.filter((root) => root.kind === 'hf-hub').map((root) => root.id)).toEqual(['hf-hub']);
  });

  // The guard that stops a new runtime from growing a second store the app cannot
  // see: a declared root with no inventory backend, or a backend with no declared
  // root, fails here.
  it('keeps the registry and the inventory backends in lockstep', () => {
    const storeRoots = storeModelRootIds().map((id) => resolveModelRoots().find((root) => root.id === id));
    expect(storeRoots.map((root) => root.backend).sort()).toEqual(Object.keys(MODEL_STORE_BACKENDS).sort());
    for (const root of storeRoots) expect(MODEL_INVENTORY_BACKENDS).toContain(root.backend);
    expect(modelRootForBackend('huggingface').id).toBe('hf-hub');
  });

  it('marks only the hand-placed directories as unmanaged layouts', () => {
    expect(resolveModelRoots().filter((root) => !root.managed).map((root) => root.id).sort()).toEqual(['portos-models', 'repo-models']);
  });

  it('resolves from the home directory by default and honors the documented overrides', () => {
    expect(modelRootPath('mtplx')).toBe(join(homedir(), '.mtplx'));
    expect(modelRootPath('portos-models')).toBe(join(homedir(), '.portos', 'models'));
    expect(modelRootPath('auk-ckpts')).toBe(join(homedir(), '.portos', 'auk', 'ckpts'));
    expect(modelRootPath('hf-xet-cache')).toBe(join(homedir(), '.cache', 'huggingface', 'xet'));

    process.env.MTPLX_HOME = '/example/mtplx';
    process.env.PORTOS_MODELS_HOME = '/example/models';
    process.env.PORTOS_REPO_MODELS_DIR = '/example/checkout-models';
    process.env.HF_HOME = '/example/hf';
    expect(modelRootPath('mtplx')).toBe('/example/mtplx');
    expect(modelRootPath('portos-models')).toBe('/example/models');
    expect(modelRootPath('repo-models')).toBe('/example/checkout-models');
    expect(modelRootPath('hf-xet-cache')).toBe(join('/example/hf', 'xet'));
    expect(modelRootPath('hf-hub')).toBe(join('/example/hf', 'hub'));
  });

  it('rejects an undeclared root id', () => {
    expect(() => modelRootPath('nope')).toThrow(/Unknown model root/);
  });

  // runtimes.js declares this path itself (importing the registry there would add a
  // module to every boot); this is what keeps the two from drifting apart.
  it('pins the FastVideo checkpoint root to the runtime that writes it', () => {
    expect(modelRootPath('fastvideo-mlx')).toBe(FASTVIDEO_MLX_CHECKPOINT_DIR);
  });
});
