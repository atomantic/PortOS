import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdir, mkdtemp, rm, stat, symlink, truncate, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

vi.mock('../services/modelManifest.js', () => ({ recordModelUninstall: vi.fn(async () => true) }));
vi.mock('../services/cos/cosTaskStore.js', () => ({ addTask: vi.fn() }));
vi.mock('../services/mediaModelInstall.js', () => ({ addModelFromHuggingface: vi.fn() }));

const { default: routes } = await import('./imageVideoModels.js');
const { recordModelUninstall } = await import('../services/modelManifest.js');
const { listModelStore } = await import('../services/modelStoreStorage.js');

const app = express();
app.use(express.json());
app.use('/api/image-video/models', routes);
app.use(errorMiddleware);

const ENV_KEYS = ['MTPLX_HOME', 'HY3DGEN_MODELS', 'HF_XET_CACHE', 'PIXIE_FORGE_HOME', 'SLOTSTREAM_MODEL_DIR', 'PORTOS_MODELS_HOME', 'PORTOS_REPO_MODELS_DIR'];
const NEW_BACKENDS = ['slotstream', 'fastvideo-mlx', 'auk-ckpts', 'portos-models', 'repo-models', 'legacy-runtime'];
const GIB = 1024 ** 3;
// A sparse file: stat() reports the size without writing a gibibyte to disk.
const fillSparse = async (path, bytes) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '');
  await truncate(path, bytes);
};
const exists = (path) => stat(path).then(() => true, () => false);
const fill = async (path, bytes) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, Buffer.alloc(bytes, 1));
};

let root;
let realHome;
let realUserProfile;
beforeEach(async () => {
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'model-stores-'));
  process.env.MTPLX_HOME = join(root, 'mtplx');
  process.env.HY3DGEN_MODELS = join(root, 'hy3dgen');
  process.env.HF_XET_CACHE = join(root, 'xet');
  process.env.PIXIE_FORGE_HOME = join(root, 'pixie');
  process.env.SLOTSTREAM_MODEL_DIR = join(root, 'slotstream');
  process.env.PORTOS_MODELS_HOME = join(root, 'portos-models');
  process.env.PORTOS_REPO_MODELS_DIR = join(root, 'repo-models');
  // The runtime roots under ~/.portos resolve from the home directory.
  process.env.HOME = join(root, 'home');
  process.env.USERPROFILE = join(root, 'home');
});
afterEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of [['HOME', realHome], ['USERPROFILE', realUserProfile]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe('file-system model stores', () => {
  it('reports missing roots as empty, not as an error', async () => {
    for (const backend of ['mtplx', 'hy3dgen', 'hf-xet-cache', 'pixie-forge', ...NEW_BACKENDS]) {
      expect(await listModelStore(backend)).toEqual({ items: [], totalBytes: 0 });
    }
  });

  it('sizes each store from the scan', async () => {
    await fill(join(root, 'mtplx', 'models', 'org--ckpt', 'w.bin'), 300);
    await fill(join(root, 'mtplx', 'session-bank', 's.bin'), 50);
    await fill(join(root, 'hy3dgen', 'hunyuan-repo', 'w.bin'), 200);
    await fill(join(root, 'pixie', 'loras', 'lora-style.safetensors'), 70);
    await fill(join(root, 'pixie', 'loras', 'notes.txt'), 9);

    const mtplx = await listModelStore('mtplx');
    expect(mtplx.items.map((i) => i.key)).toEqual(['org--ckpt', 'session-bank']);
    expect(mtplx.totalBytes).toBeGreaterThanOrEqual(350);
    expect((await listModelStore('hy3dgen')).items.map((i) => i.key)).toEqual(['hunyuan-repo']);
    const pixie = await listModelStore('pixie-forge');
    expect(pixie.items.map((i) => [i.key, i.size])).toEqual([['lora-style.safetensors', 70]]);
  });

  it('deletes a checkpoint, frees its bytes and drops the manifest entry', async () => {
    const dir = join(root, 'mtplx', 'models', 'org--ckpt');
    await fill(join(dir, 'w.bin'), 300);
    const res = await request(app).delete('/api/image-video/models/store/mtplx/org--ckpt');
    expect(res.status).toBe(200);
    expect(res.body.freedBytes).toBeGreaterThanOrEqual(300);
    expect(await exists(dir)).toBe(false);
    expect(recordModelUninstall).toHaveBeenCalledWith({ backend: 'mtplx', key: 'org--ckpt' });
  });

  it('clears the session bank but keeps its directory', async () => {
    const bank = join(root, 'mtplx', 'session-bank');
    await fill(join(bank, 'a', 's.bin'), 50);
    expect((await request(app).delete('/api/image-video/models/store/mtplx/session-bank')).status).toBe(200);
    expect(await exists(bank)).toBe(true);
    expect(await exists(join(bank, 'a'))).toBe(false);
  });

  // Regression: a symlinked session-bank must not turn "clear the cache" into
  // "delete the children of wherever the link points".
  it('ignores a session-bank symlink instead of clearing its target', async () => {
    const outside = join(root, 'outside');
    await fill(join(outside, 'precious.bin'), 10);
    await mkdir(join(root, 'mtplx'), { recursive: true });
    await symlink(outside, join(root, 'mtplx', 'session-bank'));
    expect((await listModelStore('mtplx')).items).toEqual([]);
    expect((await request(app).delete('/api/image-video/models/store/mtplx/session-bank')).status).toBe(404);
    expect(await exists(join(outside, 'precious.bin'))).toBe(true);
  });

  it('ignores a models directory that is a symlink out of the store', async () => {
    const outside = join(root, 'outside');
    await fill(join(outside, 'org--external', 'w.bin'), 10);
    await mkdir(join(root, 'mtplx'), { recursive: true });
    await symlink(outside, join(root, 'mtplx', 'models'));
    expect((await listModelStore('mtplx')).items).toEqual([]);
    expect((await request(app).delete('/api/image-video/models/store/mtplx/org--external')).status).toBe(404);
    expect(await exists(join(outside, 'org--external'))).toBe(true);
  });

  it('clears xet chunk caches and only logs older than 7 days', async () => {
    await fill(join(root, 'xet', 'abc', 'chunk_cache', 'c.bin'), 100);
    await fill(join(root, 'xet', 'logs', 'old.log'), 40);
    await fill(join(root, 'xet', 'logs', 'new.log'), 30);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(root, 'xet', 'logs', 'old.log'), old, old);

    const { items } = await listModelStore('hf-xet-cache');
    expect(items).toHaveLength(1);
    expect(items[0].size).toBeGreaterThanOrEqual(140);
    expect((await request(app).delete('/api/image-video/models/store/hf-xet-cache/chunk-cache')).status).toBe(200);
    expect(await exists(join(root, 'xet', 'abc', 'chunk_cache'))).toBe(false);
    expect(await exists(join(root, 'xet', 'logs', 'old.log'))).toBe(false);
    expect(await exists(join(root, 'xet', 'logs', 'new.log'))).toBe(true);
  });

  it('deletes a Pixie Forge LoRA by filename within its root only', async () => {
    await fill(join(root, 'pixie', 'loras', 'lora-style.safetensors'), 70);
    await fill(join(root, 'pixie', 'keep.safetensors'), 10);
    expect((await request(app).delete('/api/image-video/models/store/pixie-forge/lora-style.safetensors')).status).toBe(200);
    expect(await exists(join(root, 'pixie', 'loras', 'lora-style.safetensors'))).toBe(false);
    expect(await exists(join(root, 'pixie', 'keep.safetensors'))).toBe(true);
  });

  it('404s an unknown key and 400s traversal or an unknown store without touching disk', async () => {
    await fill(join(root, 'hy3dgen', 'repo', 'w.bin'), 10);
    await fill(join(root, 'sibling.txt'), 10);
    expect((await request(app).delete('/api/image-video/models/store/hy3dgen/missing')).status).toBe(404);
    expect((await request(app).delete('/api/image-video/models/store/hy3dgen/%2e%2e%2fsibling.txt')).status).toBe(400);
    expect((await request(app).delete('/api/image-video/models/store/hy3dgen/a%5Cb')).status).toBe(400);
    expect((await request(app).delete('/api/image-video/models/store/nope/repo')).status).toBe(400);
    expect(await exists(join(root, 'sibling.txt'))).toBe(true);
    expect(await exists(join(root, 'hy3dgen', 'repo'))).toBe(true);
    expect(recordModelUninstall).not.toHaveBeenCalled();
  });
});

describe('declared model roots outside the hub cache', () => {
  const home = () => join(root, 'home', '.portos');

  it('flags large weights in a hand-placed directory as unmanaged, and nothing else', async () => {
    await fillSparse(join(root, 'portos-models', 'Big-MLX-4bit', 'model-00001.safetensors'), GIB + 1);
    await fill(join(root, 'portos-models', 'Small-Repo', 'config.json'), 20);
    await fillSparse(join(root, 'portos-models', 'Loose-Q4.gguf'), GIB);
    await fill(join(root, 'portos-models', 'notes.txt'), 5);
    await fillSparse(join(root, 'portos-models', '.cache', 'hidden.safetensors'), 2 * GIB);

    const { items } = await listModelStore('portos-models');
    const byKey = Object.fromEntries(items.map((entry) => [entry.key, entry]));
    expect(Object.keys(byKey).sort()).toEqual(['Big-MLX-4bit', 'Loose-Q4.gguf', 'Small-Repo']);
    expect(byKey['Big-MLX-4bit']).toMatchObject({ unmanaged: true });
    expect(byKey['Big-MLX-4bit'].detail).toMatch(/1 weight file of 1 GiB or more outside the Hugging Face cache/);
    expect(byKey['Loose-Q4.gguf']).toMatchObject({ unmanaged: true, size: GIB });
    expect(byKey['Small-Repo'].unmanaged).toBe(false);
  });

  // Models → Runtimes downloads a preset's weights to models/<file> in the checkout,
  // so those files are a layout PortOS writes; only the rest is hand-placed.
  it('scans the checkout models directory, treating preset downloads as managed', async () => {
    await fillSparse(join(root, 'repo-models', 'Ternary-Bonsai-2-27B-PQ2_0.gguf'), GIB + 5);
    await fillSparse(join(root, 'repo-models', 'Hand-Fetched-Q4.gguf'), GIB + 5);
    const { items } = await listModelStore('repo-models');
    expect(items.map((entry) => [entry.key, entry.unmanaged]).sort()).toEqual([
      ['Hand-Fetched-Q4.gguf', true],
      ['Ternary-Bonsai-2-27B-PQ2_0.gguf', false],
    ]);
    expect(items.find((entry) => entry.key === 'Ternary-Bonsai-2-27B-PQ2_0.gguf').detail).toMatch(/preset weights/);
  });

  it('never calls a root PortOS or its runtimes manage "unmanaged", however large', async () => {
    await fillSparse(join(home(), 'fastvideo', 'mlx-checkpoints', 'snap-int8', 'dit.safetensors'), 2 * GIB);
    await fillSparse(join(home(), 'auk', 'ckpts', 'mlx', 'vae.safetensors'), 2 * GIB);
    await fillSparse(join(root, 'slotstream', 'org__model', 'w.safetensors'), 2 * GIB);
    for (const backend of ['fastvideo-mlx', 'auk-ckpts', 'slotstream']) {
      const { items } = await listModelStore(backend);
      expect(items).toHaveLength(1);
      expect(items[0].unmanaged).toBe(false);
    }
  });

  it('deletes a hand-placed file through the guarded path and drops its manifest entry', async () => {
    const file = join(root, 'portos-models', 'Loose-Q4.gguf');
    await fillSparse(file, GIB);
    await fill(join(root, 'portos-models', 'keep.gguf'), 10);
    const res = await request(app).delete('/api/image-video/models/store/portos-models/Loose-Q4.gguf');
    expect(res.status).toBe(200);
    expect(res.body.freedBytes).toBe(GIB);
    expect(await exists(file)).toBe(false);
    expect(await exists(join(root, 'portos-models', 'keep.gguf'))).toBe(true);
    expect(recordModelUninstall).toHaveBeenCalledWith({ backend: 'portos-models', key: 'Loose-Q4.gguf' });
  });

  it('skips symlinks in a hand-placed directory instead of listing or deleting their targets', async () => {
    const outside = join(root, 'outside');
    await fill(join(outside, 'precious.gguf'), 10);
    await mkdir(join(root, 'portos-models'), { recursive: true });
    await symlink(outside, join(root, 'portos-models', 'linked-dir'));
    await symlink(join(outside, 'precious.gguf'), join(root, 'portos-models', 'linked.gguf'));
    expect((await listModelStore('portos-models')).items).toEqual([]);
    expect((await request(app).delete('/api/image-video/models/store/portos-models/linked-dir')).status).toBe(404);
    expect((await request(app).delete('/api/image-video/models/store/portos-models/linked.gguf')).status).toBe(404);
    expect(await exists(join(outside, 'precious.gguf'))).toBe(true);
  });

  it('reports a retired runtime, dangling snapshot link included, and reclaims it whole', async () => {
    const runtime = join(home(), 'hunyuan-video-mlx');
    await fill(join(runtime, 'portos-models', 'text_encoder', 'w.safetensors'), 120);
    await symlink(join(root, 'gone', 'snapshots', 'abc'), join(runtime, 'portos-models', 'hunyuan-video-t2v-720p'));

    const { items } = await listModelStore('legacy-runtime');
    expect(items.map((entry) => entry.key)).toEqual(['hunyuan-video-mlx']);
    expect(items[0].size).toBeGreaterThanOrEqual(120);

    const res = await request(app).delete('/api/image-video/models/store/legacy-runtime/hunyuan-video-mlx');
    expect(res.status).toBe(200);
    expect(await exists(runtime)).toBe(false);
    expect(await exists(home())).toBe(true);
    expect(recordModelUninstall).toHaveBeenCalledWith({ backend: 'legacy-runtime', key: 'hunyuan-video-mlx' });
  });

  it('names a converted checkpoint source and prunes only that transformer directory', async () => {
    const previousHub = process.env.HF_HUB_CACHE;
    const hub = join(root, 'hub');
    process.env.HF_HUB_CACHE = hub;
    try {
      const revision = 'a'.repeat(40);
      const transformer = join(hub, 'models--Org--Repo', 'snapshots', revision, 'transformer');
      const vae = join(hub, 'models--Org--Repo', 'snapshots', revision, 'vae', 'vae.safetensors');
      await fill(join(transformer, 'model.safetensors'), 32);
      await fill(vae, 8);
      const cache = join(home(), 'fastvideo', 'mlx-checkpoints', 'snap');
      await fill(join(cache, 'int8', 'mlx_h3_dit.safetensors'), 4);
      await writeFile(join(cache, 'portos-source.json'), JSON.stringify({
        sourceRepo: 'Org/Repo',
        sourceRevision: revision,
        sourceWeights: transformer,
        prunable: true,
      }));

      const { items } = await listModelStore('fastvideo-mlx');
      expect(items).toHaveLength(1);
      expect(items[0].detail).toContain('Org/Repo@aaaaaaaa');
      expect(items[0].detail).toContain('source weights (re-downloadable; needed only to re-convert)');
      expect(items[0].sourcePrune).toEqual({ backend: 'fastvideo-mlx', key: 'snap' });

      const res = await request(app).delete('/api/image-video/models/store/fastvideo-mlx/snap/source');
      expect(res.status).toBe(200);
      expect(await exists(transformer)).toBe(false);
      expect(await exists(vae)).toBe(true);
      expect(await exists(join(cache, 'int8', 'mlx_h3_dit.safetensors'))).toBe(true);
      expect(recordModelUninstall).not.toHaveBeenCalled();
    } finally {
      if (previousHub === undefined) delete process.env.HF_HUB_CACHE;
      else process.env.HF_HUB_CACHE = previousHub;
    }
  });

  it('names AuK sources and does not offer to prune them', async () => {
    const flash = join(home(), 'auk', 'ckpts', 'AuK-Flash');
    await fill(join(flash, 'config.yaml'), 10);
    await writeFile(join(flash, 'portos-source.json'), JSON.stringify({
      sourceRepo: 'tencent/AuK-Flash',
      sourceRevision: null,
      prunable: true,
      sourceWeights: flash,
    }));
    await fill(join(home(), 'auk', 'ckpts', 'mlx', 'vae.safetensors'), 4);

    const { items } = await listModelStore('auk-ckpts');
    const byKey = Object.fromEntries(items.map((entry) => [entry.key, entry]));
    expect(byKey['AuK-Flash'].detail).toContain('tencent/AuK-Flash');
    expect(byKey['AuK-Flash'].detail).not.toContain('re-downloadable');
    expect(byKey['AuK-Flash'].sourcePrune).toBeUndefined();
    expect(byKey.mlx.detail).toContain('Qwen/Qwen2.5-Omni-3B');
    expect(byKey.mlx.sourcePrune).toBeUndefined();

    const res = await request(app).delete('/api/image-video/models/store/auk-ckpts/AuK-Flash/source');
    expect(res.status).toBe(409);
    expect(await exists(join(flash, 'config.yaml'))).toBe(true);
  });
});
