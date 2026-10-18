import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const fixture = vi.hoisted(() => ({ root: '', manifest: { repo: 'example/moss', revision: 'immutable-revision', files: [] } }));
vi.mock('./mossRuntime.js', () => ({ MOSS_MANIFEST: fixture.manifest, mossSnapshot: () => fixture.root }));
import { downloadMossWeights, mossModelCacheStatus, verifyMossWeights } from './mossWeights.js';

const digest = data => createHash('sha256').update(data).digest('hex');
const header = Buffer.from(JSON.stringify({ tensor: { dtype: 'U8', shape: [2], data_offsets: [0, 2] } }));
const prefix = Buffer.alloc(8);
prefix.writeBigUInt64LE(BigInt(header.length));
const tensor = Buffer.concat([prefix, header, Buffer.from([1, 2])]);
const config = Buffer.from('{"variant":"SFT"}');

beforeEach(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'portos-moss-weights-'));
  fixture.manifest.files = [
    { path: 'config.json', size: config.length, sha256: digest(config) },
    { path: 'transformer/model.safetensors', size: tensor.length, sha256: digest(tensor) },
  ];
  await mkdir(join(fixture.root, 'transformer'));
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(fixture.root, { recursive: true, force: true }); });

describe('pinned MOSS weight workflow', () => {
  it('reports incomplete snapshots, downloads only required files and checks same-size corruption', async () => {
    await writeFile(join(fixture.root, 'config.json'), config);
    const missing = await mossModelCacheStatus('moss');
    expect(missing).toMatchObject({ cached: false, revision: 'immutable-revision', integrity: { status: 'missing', badFiles: [{ name: 'transformer/model.safetensors' }] } });
    expect(JSON.stringify(missing)).not.toContain(fixture.root);
    const fetcher = vi.fn(async () => new Response(tensor, { headers: { 'content-length': String(tensor.length) } }));
    vi.stubGlobal('fetch', fetcher);
    const events = [];
    await downloadMossWeights(event => events.push(event)).promise;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://huggingface.co/example/moss/resolve/immutable-revision/transformer/model.safetensors');
    expect(await readFile(join(fixture.root, 'transformer/model.safetensors'))).toEqual(tensor);
    expect(events.at(-1).type).toBe('complete');
    expect((await mossModelCacheStatus('moss')).cached).toBe(true);
    await downloadMossWeights(() => {}).promise;
    expect(fetcher).toHaveBeenCalledTimes(1);
    const corrupted = Buffer.from(tensor);
    corrupted[corrupted.length - 1] = 3;
    await writeFile(join(fixture.root, 'transformer/model.safetensors'), corrupted);
    expect(await verifyMossWeights({ deep: true })).toMatchObject({ cached: false, status: 'bad', files: [expect.anything(), { ok: false, reason: 'hash-mismatch' }] });
  });

  it('aborts a transfer, prevents a concurrent writer and releases its slot without claiming completion', async () => {
    let entered;
    const fetching = new Promise(resolve => { entered = resolve; });
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      entered();
    })));
    const events = [];
    const handle = downloadMossWeights(event => events.push(event));
    expect(() => downloadMossWeights(() => {})).toThrow(/already downloading/);
    await fetching;
    handle.kill();
    await expect(handle.promise).rejects.toMatchObject({ code: 'MOSS_DOWNLOAD_CANCELLED' });
    expect(events.some(event => event.type === 'complete')).toBe(false);
    const next = downloadMossWeights(() => {});
    next.kill();
    await expect(next.promise).rejects.toMatchObject({ code: 'MOSS_DOWNLOAD_CANCELLED' });
  });
});
