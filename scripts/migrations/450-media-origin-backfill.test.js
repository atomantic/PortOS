import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './450-media-origin-backfill.js';

const PAIRED_AT = '2026-06-01T00:00:00.000Z';
const BEFORE = new Date('2026-05-01T00:00:00.000Z');
const AFTER = new Date('2026-07-01T00:00:00.000Z');

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function machine({ self = 'inst-local', peers = [{ instanceId: 'inst-peer', addedAt: PAIRED_AT }], hosted = null } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'media-origin-'));
  roots.push(rootDir);
  const data = join(rootDir, 'data');
  await mkdir(join(data, 'videos'), { recursive: true });
  await mkdir(join(data, 'images'), { recursive: true });
  await writeFile(join(data, 'instances.json'), JSON.stringify({ self: { instanceId: self }, peers }));
  if (hosted) await writeFile(join(data, 'peer-hosted-media.json'), JSON.stringify({ version: 1, entries: hosted }));
  const file = async (dir, name, when, body = 'x') => {
    await writeFile(join(data, dir, name), body);
    await utimes(join(data, dir, name), when, when);
  };
  const json = (path) => readFile(join(data, path), 'utf8').then(JSON.parse);
  return { rootDir, data, file, json };
}

describe('media origin backfill migration', () => {
  it('stamps media made before pairing as local and a pulled copy as its single supplier, so both machines agree', async () => {
    const creator = await machine({ self: 'inst-a', peers: [{ instanceId: 'inst-b', addedAt: PAIRED_AT }] });
    await creator.file('videos', 'clip.mp4', BEFORE);
    await creator.file('images', 'still.png', BEFORE);
    await writeFile(join(creator.data, 'video-history.json'), JSON.stringify([{ id: 'v1', filename: 'clip.mp4', createdAt: '2026-04-30T00:00:00Z' }]));

    const copy = await machine({ self: 'inst-b', peers: [{ instanceId: 'inst-a', addedAt: PAIRED_AT }], hosted: { 'image:still.png': { peerId: 'inst-a', hosts: [{ peerId: 'inst-a' }] } } });
    await copy.file('videos', 'clip.mp4', AFTER);
    await writeFile(join(copy.data, 'video-history.json'), JSON.stringify([{ id: 'v1', filename: 'clip.mp4', createdAt: '2026-04-30T00:00:00Z', suppliedByInstanceId: 'inst-a' }]));
    await writeFile(join(copy.data, 'images', 'still.metadata.json'), JSON.stringify({ prompt: 'a cat' }));

    expect(await migration.up({ rootDir: creator.rootDir })).toEqual({ videos: 1, images: 1 });
    expect(await migration.up({ rootDir: copy.rootDir })).toEqual({ videos: 1, images: 1 });

    // The creator's own rows now carry its id, which is what announces their deletes to peers.
    expect((await creator.json('video-history.json'))[0].originInstanceId).toBe('inst-a');
    expect(await creator.json('images/still.metadata.json')).toEqual({ originInstanceId: 'inst-a' });
    expect((await copy.json('video-history.json'))[0]).toMatchObject({ originInstanceId: 'inst-a', suppliedByInstanceId: 'inst-a' });
    expect(await copy.json('images/still.metadata.json')).toEqual({ prompt: 'a cat', originInstanceId: 'inst-a' });
  });

  it('leaves media whose origin is not evidenced without one', async () => {
    const m = await machine({ hosted: { 'video:hosted.mp4': { peerId: 'inst-y', hosts: [{ peerId: 'inst-y' }] } } });
    for (const name of ['pulled.mp4', 'hosted.mp4']) await m.file('videos', name, AFTER);
    await m.file('videos', 'mine.mp4', BEFORE);
    await m.file('images', 'pulled.png', AFTER);
    await m.file('images', 'broken.png', BEFORE);
    await writeFile(join(m.data, 'images', 'broken.metadata.json'), '{not json');
    await m.file('images', 'photo.jpg', BEFORE);
    await writeFile(join(m.data, 'images', 'photo.metadata.json'), '{}');
    const rows = [
      // Bytes written after pairing: an old pull looks exactly like this.
      { id: 'pulled', filename: 'pulled.mp4' },
      // Two different machines handed it over: ambiguous.
      { id: 'hosted', filename: 'hosted.mp4', suppliedByInstanceId: 'inst-x' },
      { id: 'owned', filename: 'mine.mp4', originInstanceId: 'inst-other' },
      { id: 'gone', filename: 'missing.mp4' },
      { id: 'escape', filename: '../videos/mine.mp4' },
    ];
    await writeFile(join(m.data, 'video-history.json'), JSON.stringify(rows));

    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ videos: 0, images: 0 });
    expect(await m.json('video-history.json')).toEqual(rows);
    expect(existsSync(join(m.data, 'images', 'pulled.metadata.json'))).toBe(false);
    expect(await readFile(join(m.data, 'images', 'broken.metadata.json'), 'utf8')).toBe('{not json');
    expect(await m.json('images/photo.metadata.json')).toEqual({});
  });

  it('claims nothing locally when a peer record has no pairing time', async () => {
    const m = await machine({ peers: [{ instanceId: 'inst-peer' }] });
    await m.file('videos', 'old.mp4', BEFORE);
    await writeFile(join(m.data, 'video-history.json'), JSON.stringify([{ id: 'old', filename: 'old.mp4' }]));
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ videos: 0, images: 0 });
  });

  it('stamps every held file on an install with no peers, and a re-run changes nothing', async () => {
    const m = await machine({ peers: [] });
    await m.file('videos', 'recent.mp4', AFTER);
    await m.file('images', 'recent.png', AFTER);
    await writeFile(join(m.data, 'video-history.json'), JSON.stringify([{ id: 'r', filename: 'recent.mp4' }]));
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ videos: 1, images: 1 });
    const history = await readFile(join(m.data, 'video-history.json'), 'utf8');
    const sidecar = await readFile(join(m.data, 'images', 'recent.metadata.json'), 'utf8');
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ videos: 0, images: 0 });
    expect(await readFile(join(m.data, 'video-history.json'), 'utf8')).toBe(history);
    expect(await readFile(join(m.data, 'images', 'recent.metadata.json'), 'utf8')).toBe(sidecar);
  });

  it('skips an install without media', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'media-origin-'));
    roots.push(rootDir);
    expect(await migration.up({ rootDir })).toEqual({ videos: 0, images: 0, reason: 'no-media' });
  });
});
