import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _createMetalBufferProfiles, metalBufferExecutionSignature } from './metalBufferProfiles.js';

const signature = number => number.toString(16).padStart(64, '0');
let root;
let file;
let now;
let store;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'portos-metal-profile-'));
  file = join(root, 'cache', 'profiles.json');
  now = 100000;
  store = _createMetalBufferProfiles({ file, now: () => now });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('successful Metal profile persistence', () => {
  it('starts stock, reloads proven entries after restart, expires them and bounds concurrent updates', async () => {
    expect(await store.lookup(signature(1))).toMatchObject({ applied: false, diagnostic: 'empty' });
    await Promise.all(Array.from({ length: 130 }, async (_, index) => {
      const token = await store.lookup(signature(index));
      await store.learn(token);
    }));
    const reloaded = _createMetalBufferProfiles({ file, now: () => now });
    expect(await reloaded.lookup(signature(0))).toMatchObject({ applied: false });
    expect(await reloaded.lookup(signature(129))).toMatchObject({ applied: true });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.entries).toHaveLength(128);
    expect(saved.entries.map(entry => entry.signature)).toEqual(Array.from({ length: 128 }, (_, i) => signature(i + 2)));
    expect(Object.keys(saved.entries[0]).sort()).toEqual(['learnedAt', 'signature']);
    now += 24 * 60 * 60 * 1000;
    expect(await reloaded.lookup(signature(129))).toMatchObject({ applied: false });
  });

  it('clear drains earlier writes and fences late success from jobs already in flight', async () => {
    let releaseWrite;
    const writing = new Promise(resolve => { releaseWrite = resolve; });
    let enteredWrite;
    const entered = new Promise(resolve => { enteredWrite = resolve; });
    const slow = _createMetalBufferProfiles({ file, now: () => now, write: async (_file, data) => {
      enteredWrite();
      await writing;
      await mkdir(join(root, 'cache'), { recursive: true });
      await writeFile(file, JSON.stringify(data));
    } });
    const token = await slow.lookup(signature(1));
    const learning = slow.learn(token);
    await entered;
    const clearing = slow.clear();
    const staleLearning = slow.learn(token);
    releaseWrite();
    await Promise.all([learning, clearing]);
    expect(await staleLearning).toMatchObject({ learned: false, diagnostic: 'invalidated' });
    expect(await slow.lookup(signature(1))).toMatchObject({ applied: false, diagnostic: 'ready' });
    await slow.learn(await slow.lookup(signature(2)));
    expect(await slow.lookup(signature(2))).toMatchObject({ applied: true });
    await slow.invalidate(await slow.lookup(signature(2)));
    expect(await slow.lookup(signature(2))).toMatchObject({ applied: false });
  });

  it.each(['{"version":2,"entries":[]}', 'broken json'])('refuses unverified cache state until an operator clears it (%s)', async contents => {
    await mkdir(join(root, 'cache'));
    await writeFile(file, contents);
    const token = await store.lookup(signature(1));
    expect(token).toMatchObject({ applied: false, diagnostic: 'invalid-or-unknown-version' });
    expect(await store.learn(token)).toMatchObject({ learned: false });
    expect(await readFile(file, 'utf8')).toBe(contents);
    await store.clear();
    expect(await store.lookup(signature(1))).toMatchObject({ diagnostic: 'ready' });
  });

  it('distinguishes a read failure from a verified empty cache', async () => {
    const unreadable = _createMetalBufferProfiles({ file, read: vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' })) });
    const token = await unreadable.lookup(signature(1));
    expect(token).toMatchObject({ applied: false, diagnostic: 'unreadable' });
    expect(await unreadable.learn(token)).toMatchObject({ learned: false, diagnostic: 'unreadable' });
  });

  it('a failed invalidation disables reuse until a successful clear repairs storage', async () => {
    const write = vi.fn(async (_file, data) => {
      await mkdir(join(root, 'cache'), { recursive: true });
      await writeFile(file, JSON.stringify(data));
    });
    const failing = _createMetalBufferProfiles({ file, write, now: () => now });
    await failing.learn(await failing.lookup(signature(1)));
    const learned = await failing.lookup(signature(1));
    expect(learned.applied).toBe(true);
    write.mockRejectedValueOnce(new Error('write failed'));
    await expect(failing.invalidate(learned)).rejects.toThrow('write failed');
    expect(await failing.lookup(signature(1))).toMatchObject({ applied: false, diagnostic: 'write-failed' });
    await failing.clear();
    expect(await failing.lookup(signature(1))).toMatchObject({ applied: false, diagnostic: 'ready' });
  });
});

it('binds execution shape and current runtime/helper/model/encoder/memory evidence without binding prompt, seed or source names', async () => {
  const helper = join(root, 'render.py');
  const bin = join(root, 'python');
  await writeFile(helper, 'example helper');
  await writeFile(bin, 'example executable');
  const input = {
    model: { id: 'example', revision: 'a'.repeat(40), requiredWeights: [{ repo: 'example/encoder', revision: 'b'.repeat(40) }] },
    runtimeInfo: { expectedRevision: 'c'.repeat(40), fingerprintPackages: ['mlx'] },
    fingerprint: { versions: { mlx: '1.0' }, python: '3.12', chip: 'example-chip', os: 'example-os' },
    args: [helper, '--prompt', 'Example prompt', '--output', '/example/result.mp4', '--seed', '1', '--image', '/example/source.png', '--streaming-mode', 'auto', '--sampler', 'euler'],
    bin, meta: { mode: 'image', width: 512, height: 512, numFrames: 25, fps: 24, steps: 8 }, env: {}, policy: { example: 'caps' },
  };
  const initial = await metalBufferExecutionSignature(input);
  expect(initial).toMatch(/^[a-f0-9]{64}$/);
  expect(await metalBufferExecutionSignature({ ...input, args: [helper, '--prompt', 'Another prompt', '--output', '/example/other.mp4', '--seed', '2', '--image', '/example/another.png', '--streaming-mode', 'auto', '--sampler', 'euler'] })).toBe(initial);
  for (const changed of [
    { model: { ...input.model, revision: 'd'.repeat(40) } },
    { runtimeInfo: { ...input.runtimeInfo, expectedRevision: 'e'.repeat(40) } },
    { fingerprint: { ...input.fingerprint, versions: { mlx: '2.0' } } },
    { encoder: { id: 'example', revision: 'f'.repeat(40) } },
    { meta: { ...input.meta, numFrames: 49 } },
    { batch: [{}, {}] },
    { args: [...input.args, '--memory-profile', 'balanced'] },
    { env: { PORTOS_MLX_CACHE_LIMIT_MB: '1024' } },
  ]) expect(await metalBufferExecutionSignature({ ...input, ...changed })).not.toBe(initial);
  await writeFile(helper, 'changed helper');
  expect(await metalBufferExecutionSignature(input)).not.toBe(initial);
  expect(await metalBufferExecutionSignature({ ...input, fingerprint: null })).toBeNull();
  expect(await metalBufferExecutionSignature({ ...input, model: { ...input.model, revision: 'main' } })).toBeNull();
});
