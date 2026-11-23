import { mkdtemp, mkdir, rm, writeFile, rename, unlink, appendFile, realpath, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchPaths } from './fsWatcher.js';

let root;
let watchers;

const open = (targets, options) => {
  const w = watchPaths(targets, options);
  watchers.push(w);
  const events = [];
  w.on('all', (event, path) => events.push([event, path]));
  return { w, events };
};
// Native watch attaches asynchronously; let it settle before touching files.
const settle = (ms = 150) => new Promise(r => setTimeout(r, ms));
const waitFor = async (predicate, timeout = 4000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('timed out waiting for watcher event');
    await settle(20);
  }
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fswatcher-')));
  watchers = [];
});
afterEach(async () => {
  await Promise.all(watchers.map(w => w.close()));
  await rm(root, { recursive: true, force: true });
});

describe('watchPaths directories', () => {
  it('skips pre-existing files with ignoreInitial, then reports add, change and unlink', async () => {
    const dir = join(root, 'dir');
    await mkdir(dir);
    await writeFile(join(dir, 'old.txt'), 'x');
    const { w, events } = open([dir]);
    const seen = { add: [], change: [], unlink: [] };
    for (const k of Object.keys(seen)) w.on(k, p => seen[k].push(p));
    await settle();
    expect(events).toEqual([]);

    const file = join(dir, 'new.txt');
    await writeFile(file, 'a');
    await waitFor(() => seen.add.includes(file));
    await appendFile(file, 'b');
    await waitFor(() => seen.change.includes(file));
    await unlink(file);
    await waitFor(() => seen.unlink.includes(file));
    // An old file's unlink is reported because it was seeded as known.
    await unlink(join(dir, 'old.txt'));
    await waitFor(() => seen.unlink.includes(join(dir, 'old.txt')));
    expect(events.map(([e]) => e)).toEqual(['add', 'change', 'unlink', 'unlink']);
  });

  it('reports existing files as add when ignoreInitial is false', async () => {
    const dir = join(root, 'dir');
    await mkdir(dir);
    await writeFile(join(dir, 'old.txt'), 'x');
    const { events } = open([dir], { ignoreInitial: false });
    await waitFor(() => events.length > 0);
    expect(events).toEqual([['add', join(dir, 'old.txt')]]);
  });

  it('watches nested directories recursively', async () => {
    const dir = join(root, 'dir');
    await mkdir(join(dir, 'sub'), { recursive: true });
    const { events } = open([dir]);
    await settle();
    const file = join(dir, 'sub', 'deep.json');
    await writeFile(file, '{}');
    await waitFor(() => events.some(([e, p]) => e === 'add' && p === file));
  });

  it('filters paths matching the ignored regex', async () => {
    const dir = join(root, 'dir');
    await mkdir(dir);
    const { events } = open([dir], { ignored: /\.lock$/ });
    await settle();
    await writeFile(join(dir, 'a.lock'), '1');
    const kept = join(dir, 'a.txt');
    await writeFile(kept, '1');
    await waitFor(() => events.some(([, p]) => p === kept));
    await settle(200);
    expect(events.some(([, p]) => p.endsWith('.lock'))).toBe(false);
  });
});

describe('watchPaths awaitWriteFinish', () => {
  const stable = { stabilityThreshold: 200, pollInterval: 40 };

  it('holds the add until writes stop for the stability window', async () => {
    const dir = join(root, 'dir');
    await mkdir(dir);
    const { events } = open([dir], { awaitWriteFinish: stable });
    await settle();
    const file = join(dir, 'big.bin');
    const started = Date.now();
    await writeFile(file, '1');
    for (let i = 0; i < 4; i++) { await settle(80); await appendFile(file, 'more'); }
    expect(events).toEqual([]);
    await waitFor(() => events.length > 0);
    expect(events).toEqual([['add', file]]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(stable.stabilityThreshold);
  });

  it('cancels a pending stability poll when the file is unlinked mid-write', async () => {
    const dir = join(root, 'dir');
    await mkdir(dir);
    const { events } = open([dir], { awaitWriteFinish: stable });
    await settle();
    const file = join(dir, 'gone.bin');
    await writeFile(file, '1');
    await settle(60);
    await unlink(file);
    await settle(500);
    expect(events).toEqual([]);
  });
});

describe('watchPaths file targets', () => {
  it('follows atomic rename replacement and a target that does not exist yet', async () => {
    const gitDir = join(root, 'git');
    await mkdir(join(gitDir, 'refs'), { recursive: true });
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    const head = join(gitDir, 'HEAD');
    const packed = join(gitDir, 'packed-refs');
    const { events } = open([head, join(gitDir, 'refs'), packed], { ignored: /\.lock$/ });
    await settle();

    await writeFile(join(gitDir, 'HEAD.lock'), 'ref: refs/heads/next\n');
    await rename(join(gitDir, 'HEAD.lock'), head);
    await waitFor(() => events.some(([e, p]) => e === 'change' && p === head));
    // A second replacement still fires: the watch is on the parent, not the inode.
    events.length = 0;
    await writeFile(join(gitDir, 'HEAD.lock'), 'ref: refs/heads/main\n');
    await rename(join(gitDir, 'HEAD.lock'), head);
    await waitFor(() => events.some(([, p]) => p === head));

    await writeFile(join(gitDir, 'packed-refs.lock'), '# pack\n');
    await rename(join(gitDir, 'packed-refs.lock'), packed);
    await waitFor(() => events.some(([e, p]) => e === 'add' && p === packed));

    const branch = join(gitDir, 'refs', 'heads-main');
    await writeFile(branch, 'abc\n');
    await waitFor(() => events.some(([, p]) => p === branch));
    expect(events.some(([, p]) => p.endsWith('.lock'))).toBe(false);
    // Unrelated siblings of a watched file are not reported.
    // Trailing events from the branch write can land late on loaded Linux
    // inotify, so assert on the sibling's path rather than an empty list.
    const index = join(gitDir, 'index');
    await writeFile(index, 'x');
    await settle(250);
    expect(events.some(([, p]) => p === index)).toBe(false);
  });

  it('reports a same-size atomic replacement when mtime does not advance', async () => {
    const gitDir = join(root, 'git');
    await mkdir(gitDir);
    const head = join(gitDir, 'HEAD');
    // Both git ref lines are 21 bytes. A coarse clock (or one millisecond)
    // leaves size and mtime unchanged across the rename, which is the
    // replacement the parent-directory watch exists to observe.
    const stamp = new Date('2020-01-01T00:00:00Z');
    const stage = async (body) => {
      const lock = `${head}.lock`;
      await writeFile(lock, body);
      await utimes(lock, stamp, stamp);
      await rename(lock, head);
    };
    await stage('ref: refs/heads/next\n');
    const { events } = open([head]);
    await settle();
    events.length = 0;
    await stage('ref: refs/heads/main\n');
    await waitFor(() => events.some(([event, path]) => event === 'change' && path === head));
  });
});

describe('watchPaths error handling and close', () => {
  it('survives a watched directory being removed and stays closable', async () => {
    const dir = join(root, 'dir');
    await mkdir(join(dir, 'refs'), { recursive: true });
    const w = watchPaths([dir]);
    watchers.push(w);
    w.on('error', () => {});
    await settle();
    await rm(join(dir, 'refs'), { recursive: true });
    await settle(200);
    await expect(w.close()).resolves.toBeUndefined();
  });

  it('stops delivering events and releases pending timers after close', async () => {
    const dir = join(root, 'dir');
    await mkdir(dir);
    const { w, events } = open([dir], { awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 40 } });
    await settle();
    await writeFile(join(dir, 'late.txt'), '1');
    await settle(80);
    await w.close();
    expect(w.listenerCount('all')).toBe(0);
    await settle(400);
    expect(events).toEqual([]);
    await expect(w.close()).resolves.toBeUndefined();
  });
});
