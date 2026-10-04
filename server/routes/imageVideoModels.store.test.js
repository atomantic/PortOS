import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

vi.mock('../services/modelManifest.js', () => ({ recordModelUninstall: vi.fn(async () => true) }));
vi.mock('../services/cos.js', () => ({ addTask: vi.fn() }));
vi.mock('../services/mediaModelInstall.js', () => ({ addModelFromHuggingface: vi.fn() }));

const { default: routes } = await import('./imageVideoModels.js');
const { recordModelUninstall } = await import('../services/modelManifest.js');
const { listModelStore } = await import('../services/modelStoreStorage.js');

const app = express();
app.use(express.json());
app.use('/api/image-video/models', routes);
app.use(errorMiddleware);

const ENV_KEYS = ['MTPLX_HOME', 'HY3DGEN_MODELS', 'HF_XET_CACHE', 'PIXIE_FORGE_HOME'];
const exists = (path) => stat(path).then(() => true, () => false);
const fill = async (path, bytes) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, Buffer.alloc(bytes, 1));
};

let root;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'model-stores-'));
  process.env.MTPLX_HOME = join(root, 'mtplx');
  process.env.HY3DGEN_MODELS = join(root, 'hy3dgen');
  process.env.HF_XET_CACHE = join(root, 'xet');
  process.env.PIXIE_FORGE_HOME = join(root, 'pixie');
});
afterEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  await rm(root, { recursive: true, force: true });
});

describe('file-system model stores', () => {
  it('reports missing roots as empty, not as an error', async () => {
    for (const backend of ['mtplx', 'hy3dgen', 'hf-xet-cache', 'pixie-forge']) {
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
