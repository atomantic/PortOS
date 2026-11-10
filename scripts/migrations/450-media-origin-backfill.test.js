import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './450-media-origin-backfill.js';

const LOCAL = 'inst-local';
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function install({ peers = [], hosted = null, history = null } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'media-origin-'));
  roots.push(rootDir);
  const data = join(rootDir, 'data');
  await mkdir(join(data, 'videos'), { recursive: true });
  await mkdir(join(data, 'images'), { recursive: true });
  await writeFile(join(data, 'instances.json'), JSON.stringify({ self: { instanceId: LOCAL }, peers }));
  if (hosted) await writeFile(join(data, 'peer-hosted-media.json'), JSON.stringify({ version: 1, entries: hosted }));
  if (history) await writeFile(join(data, 'video-history.json'), JSON.stringify(history));
  const put = (path, body = 'x') => writeFile(join(data, path), typeof body === 'string' ? body : JSON.stringify(body));
  const read = (path) => readFile(join(data, path), 'utf8');
  return { rootDir, data, put, read, json: async (path) => JSON.parse(await read(path)) };
}

describe('media origin backfill migration', () => {
  it('claims the media an unfederated install holds, so its deletes announce once it pairs', async () => {
    const m = await install({ history: [
      { id: 'mine', filename: 'mine.mp4' },
      { id: 'gone', filename: 'gone.mp4' },
      { id: 'escape', filename: '../videos/mine.mp4' },
      { id: 'later', filename: 'later.mp4', originInstanceId: LOCAL },
    ] });
    await m.put('videos/mine.mp4');
    await m.put('images/plain.png');
    await m.put('images/described.png');
    await m.put('images/described.metadata.json', { prompt: 'a cat' });
    await m.put('images/pending.metadata.json', { prompt: 'bytes elsewhere' });
    await m.put('images/broken.png');
    await m.put('images/broken.metadata.json', '{not json');
    await m.put('images/photo.jpg');
    await m.put('images/photo.metadata.json', {});

    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ videos: 1, images: 2 });
    expect((await m.json('video-history.json')).map((row) => row.originInstanceId)).toEqual([LOCAL, undefined, undefined, LOCAL]);
    expect(await m.json('images/plain.metadata.json')).toEqual({ originInstanceId: LOCAL });
    expect(await m.json('images/described.metadata.json')).toEqual({ prompt: 'a cat', originInstanceId: LOCAL });
    expect(await m.json('images/pending.metadata.json')).toEqual({ prompt: 'bytes elsewhere' });
    expect(await m.read('images/broken.metadata.json')).toBe('{not json');
    expect(await m.json('images/photo.metadata.json')).toEqual({});

    const history = await m.read('video-history.json');
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ videos: 0, images: 0 });
    expect(await m.read('video-history.json')).toBe(history);
  });

  // An old pull looks exactly like local media, so any sign of another machine stops every claim.
  it.each([
    ['a registered peer', { peers: [{ instanceId: 'inst-peer', addedAt: '2026-06-01T00:00:00.000Z' }] }],
    ['a peer-hosted file', { hosted: { 'video:other.mp4': { peerId: 'inst-peer' } } }],
    ['a row a peer supplied', { history: [{ id: 'other', filename: 'other.mp4', suppliedByInstanceId: 'inst-peer' }] }],
    ['a row a removed peer made', { history: [{ id: 'other', filename: 'other.mp4', originInstanceId: 'inst-gone' }] }],
  ])('claims nothing on an install with %s', async (_label, setup) => {
    const m = await install(setup);
    await m.put('images/held.png');
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ videos: 0, images: 0, reason: 'federated' });
    expect(existsSync(join(m.data, 'images', 'held.metadata.json'))).toBe(false);
  });

  // A removed peer leaves its reports and releases behind (#15664).
  it.each([
    ['holdings', 'media-holders.json', { version: 1, holdings: { 'inst-gone': { video: { 'v.mp4': '2026-06-01T00:00:00.000Z' } } }, releases: [] }],
    ['file times', 'media-holders.json', { version: 1, holdings: {}, releases: [], reports: { 'inst-gone': { image: {} } } }],
    ['a queued release', 'media-holders.json', { version: 1, holdings: {}, releases: [{ peerId: 'inst-gone', kind: 'video', filename: 'v.mp4' }] }],
    ['the pre-451 holdings file', 'peer-media-holdings.json', { version: 1, peers: { 'inst-gone': { video: {} } } }],
    ['an unreadable holders record', 'media-holders.json', '{not json'],
  ])('claims nothing when the holders record names another machine by %s', async (_label, file, body) => {
    const m = await install({ history: [{ id: 'v', filename: 'v.mp4' }] });
    await m.put('videos/v.mp4');
    await m.put('images/held.png');
    await m.put(file, body);
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ videos: 0, images: 0, reason: 'federated' });
    expect((await m.json('video-history.json'))[0].originInstanceId).toBeUndefined();
    expect(existsSync(join(m.data, 'images', 'held.metadata.json'))).toBe(false);
  });

  it('still claims on an install whose holders record names only itself or nobody', async () => {
    const m = await install({ history: [{ id: 'v', filename: 'v.mp4' }] });
    await m.put('videos/v.mp4');
    await m.put('media-holders.json', { version: 1, holdings: { [LOCAL]: {} }, releases: [] });
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ videos: 1, images: 0 });
  });

  it('leaves a file written well after its record was created origin-less, and claims one written with it', async () => {
    const created = Date.parse('2026-05-01T00:00:00.000Z');
    const at = (ms) => new Date(ms);
    const m = await install({ history: [
      { id: 'copy', filename: 'copy.mp4', createdAt: new Date(created).toISOString() },
      { id: 'made', filename: 'made.mp4', createdAt: new Date(created).toISOString() },
    ] });
    await m.put('videos/copy.mp4');
    await m.put('videos/made.mp4');
    await m.put('images/copy.png');
    await m.put('images/copy.metadata.json', { prompt: 'p', createdAt: new Date(created).toISOString() });
    await m.put('images/made.png');
    await m.put('images/made.metadata.json', { prompt: 'p', createdAt: new Date(created).toISOString() });
    // Pulled a day later vs written within the five-minute skew.
    for (const path of ['videos/copy.mp4', 'images/copy.png']) await utimes(join(m.data, path), at(created + 86_400_000), at(created + 86_400_000));
    for (const path of ['videos/made.mp4', 'images/made.png']) await utimes(join(m.data, path), at(created + 60_000), at(created + 60_000));

    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ videos: 1, images: 1 });
    expect((await m.json('video-history.json')).map((row) => row.originInstanceId)).toEqual([undefined, LOCAL]);
    expect((await m.json('images/copy.metadata.json')).originInstanceId).toBeUndefined();
    expect((await m.json('images/made.metadata.json')).originInstanceId).toBe(LOCAL);
  });

  it('claims nothing when an image sidecar names another machine', async () => {
    const m = await install({ history: [{ id: 'v', filename: 'v.mp4' }] });
    await m.put('videos/v.mp4');
    await m.put('images/copied.png');
    await m.put('images/copied.metadata.json', { originInstanceId: 'inst-gone' });
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ videos: 0, images: 0, reason: 'federated' });
    expect((await m.json('video-history.json'))[0].originInstanceId).toBeUndefined();
  });

  it('skips an install without media or a readable identity', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'media-origin-'));
    roots.push(rootDir);
    expect(await migration.up({ rootDir })).toEqual({ videos: 0, images: 0, reason: 'no-media' });
    await mkdir(join(rootDir, 'data', 'images'), { recursive: true });
    await writeFile(join(rootDir, 'data', 'images', 'a.png'), 'x');
    expect(await migration.up({ rootDir })).toEqual({ videos: 0, images: 0, reason: 'no-identity' });
  });
});
