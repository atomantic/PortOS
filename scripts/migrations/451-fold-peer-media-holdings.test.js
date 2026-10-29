import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './451-fold-peer-media-holdings.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const report = (at, mtimes = { 'a.mp4': 5 }) => ({ at, mtimes, checked: Object.keys(mtimes) });

async function install({ old, store }) {
  const rootDir = await mkdtemp(join(tmpdir(), 'fold-holdings-'));
  roots.push(rootDir);
  const data = join(rootDir, 'data');
  await mkdir(data, { recursive: true });
  if (old !== undefined) await writeFile(join(data, 'peer-media-holdings.json'), typeof old === 'string' ? old : JSON.stringify(old));
  if (store !== undefined) await writeFile(join(data, 'media-holders.json'), typeof store === 'string' ? store : JSON.stringify(store));
  return { rootDir, data, json: async (name) => JSON.parse(await readFile(join(data, name), 'utf8')) };
}

describe('fold peer media holdings migration', () => {
  it('moves the reports into the holders record, keeps the newer duplicate, and retires the old file', async () => {
    const m = await install({
      old: { version: 1, peers: { p1: { video: { videoHistory: report('2026-06-02T00:00:00Z'), mediaCollections: report('2026-06-01T00:00:00Z', { 'b.mp4': 7 }) } } } },
      store: { version: 1, holdings: { p1: { video: { 'a.mp4': 'x' } } }, releases: [], reports: { p1: { video: { mediaCollections: report('2026-06-03T00:00:00Z', { 'c.mp4': 9 }) } } } },
    });
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ folded: 1 });
    const store = await m.json('media-holders.json');
    expect(store.holdings).toEqual({ p1: { video: { 'a.mp4': 'x' } } });
    expect(store.reports.p1.video.videoHistory.mtimes).toEqual({ 'a.mp4': 5 });
    expect(store.reports.p1.video.mediaCollections.mtimes).toEqual({ 'c.mp4': 9 });
    expect(existsSync(join(m.data, 'peer-media-holdings.json'))).toBe(false);
  });

  it('creates the holders record when only the old file exists, and is a no-op without it', async () => {
    const m = await install({ old: { version: 1, peers: { p1: { image: { imageLibrary: report('2026-06-02T00:00:00Z', { 'i.png': 3 }) } } } } });
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ folded: 1 });
    expect((await m.json('media-holders.json')).reports.p1.image.imageLibrary.mtimes).toEqual({ 'i.png': 3 });
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ folded: 0, reason: 'no-input' });
  });

  it('leaves an unreadable holders record and the old file untouched', async () => {
    const m = await install({ old: { version: 1, peers: {} }, store: '{not json' });
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ folded: 0, reason: 'unreadable-store' });
    expect(existsSync(join(m.data, 'peer-media-holdings.json'))).toBe(true);
    expect(await readFile(join(m.data, 'media-holders.json'), 'utf8')).toBe('{not json');
  });
});
