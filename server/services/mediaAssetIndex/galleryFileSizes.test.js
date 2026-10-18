/** Old records acquire current sizes through the paged gallery boundary. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listGalleryPage } from './gallery.js';

const state = vi.hoisted(() => ({ root: null, stat: vi.fn() }));
vi.mock('node:fs/promises', async original => {
  const actual = await original();
  state.stat.mockImplementation(actual.stat);
  return { ...actual, stat: state.stat };
});
vi.mock('../../lib/paths.js', async original => {
  const actual = await original();
  return { ...actual, PATHS: {
  ...actual.PATHS,
  get images() { return join(state.root, 'images'); },
  get videos() { return join(state.root, 'videos'); },
} };
});
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'portos-gallery-sizes-'));
  await Promise.all(['images', 'videos'].map(kind => mkdir(join(state.root, kind))));
  state.stat.mockClear();
});
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); });

it('measures only the selected mixed compact page, including legacy video records', async () => {
  await writeFile(join(state.root, 'images', 'old.png'), 'pixels');
  await writeFile(join(state.root, 'videos', 'old.mp4'), Buffer.alloc(1536));
  const image = { filename: 'old.png', createdAt: '2026-01-01', fileSizeBytes: 999 };
  const video = { id: 'old', filename: 'old.mp4', createdAt: '2026-01-02', fps: 24 };
  const options = { media: true, kind: 'all', compact: true, limit: 1, videoSnapshot: [video] };
  const first = await listGalleryPage(options, async () => [image]);
  expect(first.items).toEqual([{ kind: 'video', data: expect.objectContaining({ fileSizeBytes: 1536, fps: 24, compact: true }) }]);
  expect(state.stat.mock.calls.map(([path]) => path)).toEqual([join(state.root, 'videos', 'old.mp4')]);
  const second = await listGalleryPage({ ...options, offset: 1 }, async () => [image]);
  expect(second.items[0].data.fileSizeBytes).toBe(6);
});

it('distinguishes a measured empty file from missing, unreadable and unsafe files', async () => {
  await writeFile(join(state.root, 'images', 'empty.png'), '');
  const files = ['empty.png', 'missing.png', 'denied.png', '../outside.png'].map(filename => ({ filename, fileSizeBytes: 999 }));
  state.stat.mockImplementation(async path => {
    if (path.endsWith('denied.png')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return (await vi.importActual('node:fs/promises')).stat(path);
  });
  const page = await listGalleryPage({}, async () => files);
  expect(page.items.find(item => item.filename === 'empty.png').fileSizeBytes).toBe(0);
  for (const item of page.items.filter(item => item.filename !== 'empty.png')) expect(item).not.toHaveProperty('fileSizeBytes');
  expect(state.stat.mock.calls).toHaveLength(3);
});
