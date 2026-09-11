import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const faults = vi.hoisted(() => ({ path: null }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readFile: (...args) => args[0] === faults.path
    ? Promise.reject(Object.assign(new Error('Injected read failure'), { code: 'EACCES' }))
    : actual.readFile(...args) };
});
const root = await mkdtemp(join(tmpdir(), 'media-write-back-'));
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: root, brain: join(root, 'brain') } };
});
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'local-test', UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('./sharing/annotationIdentity.js', () => ({ resolveLocalAuthorName: async () => 'Example' }));
vi.mock('./apps.js', () => ({ getAppById: vi.fn(), PORTOS_APP_ID: 'portos-default' }));
vi.mock('./brain.js', () => ({ createLinkFromUrl: vi.fn() }));
vi.mock('./brainStorage.js', () => ({ getLinkByUrl: vi.fn() }));
vi.mock('./brainJournal.js', () => ({ getSettings: async () => ({ obsidianVaultId: null }) }));
vi.mock('./cosTaskStore.js', () => ({ addTask: vi.fn() }));
vi.mock('./humanActivity.js', () => ({ recordEvents: vi.fn() }));
vi.mock('./videoGen/history.js', () => ({ mutateVideoHistory: vi.fn() }));
vi.mock('./videoGen/events.js', () => ({ videoGenEvents: { emit: vi.fn() } }));
vi.mock('./videoDownload.js', () => ({ buildDownloadHistoryEntry: vi.fn() }));
const annotations = await import('./mediaAnnotations.js');
const records = await import('./sprites/recordsFile.js');
const ingest = await import('./youtubeIngest.js');
const stores = [
  {
    name: 'annotations', path: join(root, 'media-annotations.json'),
    mutate: () => annotations.setAnnotation('image:new.png', { starred: true }),
    prior: { annotations: { 'image:keep.png': { authors: { peer: { starred: true, note: 'keep', updatedAt: '2026-01-01T00:00:00Z' } } } } },
    assertPreserved: (value) => expect(value.annotations['image:keep.png'].authors.peer.note).toBe('keep'),
  },
  {
    name: 'sprite records', path: join(root, 'sprite-records.json'),
    mutate: () => records.createRecord({ name: 'New' }, 'new'),
    prior: [{ id: 'keep', kind: 'character', name: 'Keep', notes: 'keep' }],
    assertPreserved: (value) => expect(value.find((row) => row.id === 'keep').notes).toBe('keep'),
  },
  {
    name: 'ingest index', path: join(root, 'brain', 'youtube', 'index.json'),
    mutate: () => ingest.deleteIngest('remove'),
    prior: { keep: { videoId: 'keep', title: 'Keep' }, remove: { videoId: 'remove' } },
    assertPreserved: (value) => { expect(value.keep.title).toBe('Keep'); expect(value.remove).toBeUndefined(); },
  },
];
beforeEach(async () => { faults.path = null; await rm(root, { recursive: true, force: true }); await mkdir(root); });
afterAll(() => rm(root, { recursive: true, force: true }));

describe.each(stores)('$name persistence boundary', (store) => {
  it.each(['{', '', '   ', 'EACCES'])('preserves unreadable bytes (%j) and retries after repair', async (failure) => {
    await mkdir(join(store.path, '..'), { recursive: true });
    const bytes = failure === 'EACCES' ? JSON.stringify(store.prior) : failure;
    await writeFile(store.path, bytes);
    if (failure === 'EACCES') faults.path = store.path;
    await expect(store.mutate()).rejects.toThrow(/Unreadable/);
    faults.path = null;
    expect(await readFile(store.path, 'utf8')).toBe(bytes);
    await writeFile(store.path, JSON.stringify(store.prior));
    await store.mutate();
    store.assertPreserved(JSON.parse(await readFile(store.path, 'utf8')));
  });
  it('accepts an absent file', async () => {
    await expect(store.mutate()).resolves.toBeDefined();
  });
});
