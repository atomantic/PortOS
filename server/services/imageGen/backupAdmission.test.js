import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ root: '', beforeWrite: null }));
vi.mock('../../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    PATHS: { get images() { return state.root; }, get data() { return state.root; } },
    atomicWrite: async (path, data) => {
      await state.beforeWrite?.(path);
      return actual.atomicWrite(path, data);
    },
  };
});
vi.mock('../mediaCollections.js', () => ({ listCollections: async () => [], addItem: vi.fn(), ERR_DUPLICATE: 'duplicate' }));
vi.mock('../mediaAssetIndex/index.js', () => ({ indexImage: vi.fn() }));
vi.mock('../../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission() {} }));

const { persistVariant } = await import('./variants.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const variant = () => persistVariant({ sourceFilename: 'source.png', outFilename: 'variant.png',
  data: Buffer.from('new pixels'), variantMeta: { prompt: 'new metadata' }, logLine: '🖼️ Example variant' });
async function snapshot() {
  const files = {};
  for (const name of await readdir(state.root)) files[name] = await readFile(join(state.root, name), 'utf8');
  return files;
}

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'image-backup-admission-'));
  state.beforeWrite = null;
});
afterEach(async () => { state.beforeWrite = null; await rm(state.root, { recursive: true, force: true }); });

describe('variant publication versus snapshot file copy', () => {
  it('holds a requested cut between pixel replacement and its metadata, then snapshots the completed pair', async () => {
    const reached = deferred(); const finish = deferred();
    state.beforeWrite = async path => { if (path.endsWith('.metadata.json')) { reached.resolve(); await finish.promise; } };
    const publishing = variant();
    await reached.promise;
    expect(await readFile(join(state.root, 'variant.png'), 'utf8')).toBe('new pixels');
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
    try {
      await turn();
      expect(cutReady, 'snapshot must not capture pixels without their sidecar').toBe(false);
    } finally { finish.resolve(); }
    await publishing;
    const release = await cut;
    try {
      expect(await snapshot()).toEqual({ 'variant.png': 'new pixels', 'variant.metadata.json': expect.stringContaining('new metadata') });
    } finally { release(); }
  });

  it('leaves an existing snapshot unchanged while a replacement waits outside its cut', async () => {
    await writeFile(join(state.root, 'variant.png'), 'old pixels');
    await writeFile(join(state.root, 'variant.metadata.json'), '{"prompt":"old metadata"}');
    const release = await acquireBackupSnapshotCut();
    const publishing = variant();
    try {
      await turn();
      expect(await snapshot()).toEqual({ 'variant.png': 'old pixels', 'variant.metadata.json': '{"prompt":"old metadata"}' });
    } finally { release(); }
    await publishing;
    expect((await snapshot())['variant.png']).toBe('new pixels');
  });

  it('restores the old pair before a failed replacement releases a waiting snapshot', async () => {
    await writeFile(join(state.root, 'variant.png'), 'old pixels');
    await writeFile(join(state.root, 'variant.metadata.json'), '{"prompt":"old metadata"}');
    const reached = deferred(); const finish = deferred();
    state.beforeWrite = async path => {
      if (path.endsWith('.metadata.json')) { reached.resolve(); await finish.promise; throw new Error('sidecar disk failure'); }
    };
    const publishing = variant();
    const failed = expect(publishing).rejects.toThrow('sidecar disk failure');
    await reached.promise;
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
    try { await turn(); expect(cutReady).toBe(false); } finally { finish.resolve(); }
    await failed;
    const release = await cut;
    try {
      expect(await snapshot()).toEqual({ 'variant.png': 'old pixels', 'variant.metadata.json': '{"prompt":"old metadata"}' });
    } finally { release(); }
  });
});

it('serializes sketch replacement/deletion and snapshots matching PNG and vector state', async () => {
  // mediaSketches captures its data directory when imported; load only after the synthetic root exists.
  const { saveSketch, removeSketch, getSketch, getSketchPng } = await import('../mediaSketches.js');
  const key = 'image:example.png';
  const input = { width: 10, height: 10, strokes: [{ mode: 'draw', color: '#ffffff', size: 2, points: [{ x: 1, y: 1 }] }],
    png: `data:image/png;base64,${Buffer.from('sketch pixels').toString('base64')}` };
  await mkdir(join(state.root, 'media-sketches'), { recursive: true });
  await saveSketch(key, input);
  const release = await acquireBackupSnapshotCut();
  const deleting = removeSketch(key);
  try {
    await turn();
    expect((await getSketch(key)).hasPng).toBe(true);
    expect((await getSketchPng(key)).toString()).toBe('sketch pixels');
  } finally { release(); }
  await deleting;
  expect(await getSketch(key)).toBeNull();
  expect(await getSketchPng(key)).toBeNull();
});
