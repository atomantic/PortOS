import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listLinkedSharedBlobs, releaseSharedBlobs,
} from './hfCache.js';
import { listHfModelStorage } from '../services/mediaModelStorage.js';

// Layout mirrors huggingface_hub's shared store: bytes in hub/blobs/<xx>/<hash>,
// each model's blobs/<hash> and snapshots/<sha>/<file> are links at them.
let hub;
const addSharedBlob = (hash, bytes) => {
  const dir = join(hub, 'blobs', hash.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, hash), Buffer.alloc(bytes, 1));
  writeFileSync(join(dir, `${hash}.refs`), 'refs');
  return join(dir, hash);
};
const addModel = (dirName, files) => {
  const snap = join(hub, dirName, 'snapshots', 'a'.repeat(40));
  mkdirSync(snap, { recursive: true });
  mkdirSync(join(hub, dirName, 'blobs'), { recursive: true });
  for (const [file, blobPath] of Object.entries(files)) {
    symlinkSync(blobPath, join(hub, dirName, 'blobs', file));
    symlinkSync(join(hub, dirName, 'blobs', file), join(snap, file));
  }
};

beforeEach(() => { hub = mkdtempSync(join(tmpdir(), 'hf-shared-')); });
afterEach(() => { rmSync(hub, { recursive: true, force: true }); });

describe('shared blob store', () => {
  it('counts bytes a model only links to, and frees only blobs no sibling uses', async () => {
    const exclusive = addSharedBlob('11aaaa', 100);
    const common = addSharedBlob('22bbbb', 50);
    addModel('models--org--a', { 'w1.safetensors': exclusive, 'w2.safetensors': common });
    addModel('models--org--b', { 'w2.safetensors': common });

    const linked = await listLinkedSharedBlobs(hub, 'models--org--a');
    expect([...linked.values()].sort((x, y) => x - y)).toEqual([50, 100]);

    rmSync(join(hub, 'models--org--a'), { recursive: true });
    const result = await releaseSharedBlobs(hub, linked);

    expect(result).toEqual({ removed: 1, freedBytes: 100 });
    expect(existsSync(exclusive)).toBe(false);
    expect(existsSync(`${exclusive}.refs`)).toBe(false);
    expect(existsSync(common)).toBe(true);
  });

  it('storage report counts shared bytes per model and flags leaked blobs once in the total', async () => {
    const kept = addSharedBlob('33cccc', 10);
    addSharedBlob('44dddd', 70);
    addModel('models--org--c', { 'w.safetensors': kept });
    const prev = process.env.HF_HUB_CACHE;
    process.env.HF_HUB_CACHE = hub;
    const report = await listHfModelStorage().finally(() => {
      if (prev === undefined) delete process.env.HF_HUB_CACHE; else process.env.HF_HUB_CACHE = prev;
    });

    expect(report.models[0]).toMatchObject({ id: 'models--org--c', sharedBytes: 10 });
    expect(report.sharedStore).toEqual({ bytes: 80, unreferencedBytes: 70 });
    expect(report.totalBytes).toBeGreaterThanOrEqual(80);
  });
});
