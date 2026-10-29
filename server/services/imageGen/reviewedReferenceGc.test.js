import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, rename, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root;
let onDeletionIntent;
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return { ...actual, atomicWrite: async (path, data) => {
    await actual.atomicWrite(path, data);
    if (data?.state === 'deleting') await onDeletionIntent?.();
  }, PATHS: new Proxy({}, { get: (_, key) => key === 'data' ? root : key === 'imageRefs' ? join(root, 'image-refs') : key === 'images' ? join(root, 'images') : actual.PATHS[key] }) };
});
const { stageReviewedReference, markSnapshotState, readOwnedSnapshot } = await import('./reviewedReference.js');
const { sweepReviewedReferences } = await import('./reviewedReferenceGc.js');
const digest = createHash('sha256').update('reviewed').digest('hex');
const future = Date.now() + 8 * 24 * 60 * 60 * 1000;
let source;

beforeEach(async () => {
  onDeletionIntent = null;
  root = await mkdtemp(join(tmpdir(), 'reviewed-ref-test-'));
  await mkdir(join(root, 'images'));
  source = join(root, 'images', 'source.png');
  await writeFile(source, 'reviewed');
  await writeFile(join(root, 'media-jobs.json'), JSON.stringify({ jobs: [] }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('reviewed reference collection', () => {
  it('retains running and output-referenced inputs, then collects only a settled orphan', async () => {
    const id = await stageReviewedReference(randomUUID(), source, digest);
    const path = join(root, 'image-refs', id.filename);
    await markSnapshotState(id, 'invoked');
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
    await markSnapshotState(id, 'settled');
    await writeFile(join(root, 'images', 'output.metadata.json'), JSON.stringify({ referenceImageFilenames: [id.filename] }));
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
    expect(await readFile(path, 'utf8')).toBe('reviewed');
    await unlink(join(root, 'images', 'output.metadata.json'));
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 1 });
    await expect(lstat(join(root, 'image-refs', `snapshot-${id.snapshotId}.anchor`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
  });

  it('holds a retained output even if its provenance sidecar is missing', async () => {
    const id = await stageReviewedReference(randomUUID(), source, digest);
    await markSnapshotState(id, 'settled');
    await writeFile(join(root, 'images', `${id.jobId}.png`), 'retained output');
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
    await unlink(join(root, 'images', `${id.jobId}.png`));
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 1 });
  });

  it('retains a replaced file even with matching bytes and cannot adopt it on replay', async () => {
    const id = await stageReviewedReference(randomUUID(), source, digest);
    const path = join(root, 'image-refs', id.filename);
    // Retain the original object so the filesystem cannot recycle its inode.
    await rename(path, `${path}.original`);
    await writeFile(path, 'reviewed');
    const replacement = await lstat(path, { bigint: true });
    expect({ dev: String(replacement.dev), ino: String(replacement.ino) })
      .not.toEqual({ dev: id.dev, ino: id.ino });
    await expect(readOwnedSnapshot(id)).rejects.toMatchObject({ code: 'REVIEWED_REFERENCE_CHANGED' });
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
    expect(await readFile(path, 'utf8')).toBe('reviewed');
    await expect(readOwnedSnapshot(id)).rejects.toMatchObject({ code: 'REVIEWED_REFERENCE_CHANGED' });
  });

  it('retains an interrupted deletion when only the anchor remains', async () => {
    const id = await stageReviewedReference(randomUUID(), source, digest);
    const manifest = join(root, 'image-refs', `snapshot-${id.snapshotId}.json`);
    await markSnapshotState(id, 'settled');
    await writeFile(manifest, JSON.stringify({ ...id, state: 'deleting' }));
    await unlink(join(root, 'image-refs', id.filename));
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
    expect(JSON.parse(await readFile(manifest, 'utf8')).state).toBe('deleting');
    expect(await readFile(join(root, 'image-refs', `snapshot-${id.snapshotId}.anchor`), 'utf8')).toBe('reviewed');
  });

  it('pins the original inode and refuses replacement or loss of the anchor', async () => {
    const id = await stageReviewedReference(randomUUID(), source, digest);
    const path = join(root, 'image-refs', id.filename);
    const anchor = join(root, 'image-refs', `snapshot-${id.snapshotId}.anchor`);
    const pinned = await lstat(anchor, { bigint: true });
    expect({ dev: String(pinned.dev), ino: String(pinned.ino) }).toEqual({ dev: id.dev, ino: id.ino });
    await unlink(path);
    await writeFile(path, 'reviewed');
    const replacement = await lstat(path, { bigint: true });
    expect({ dev: String(replacement.dev), ino: String(replacement.ino) }).not.toEqual({ dev: id.dev, ino: id.ino });
    await expect(readOwnedSnapshot(id)).rejects.toMatchObject({ code: 'REVIEWED_REFERENCE_CHANGED' });
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
    expect(await readFile(path, 'utf8')).toBe('reviewed');
    await unlink(anchor);
    await expect(readOwnedSnapshot(id)).rejects.toMatchObject({ code: 'REVIEWED_REFERENCE_CHANGED' });
  });

  it('quarantines a replacement arriving after deletion intent without deleting it', async () => {
    const id = await stageReviewedReference(randomUUID(), source, digest);
    await markSnapshotState(id, 'settled');
    const path = join(root, 'image-refs', id.filename);
    onDeletionIntent = async () => {
      await unlink(path);
      await writeFile(path, 'reviewed');
    };
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
    const manifest = JSON.parse(await readFile(join(root, 'image-refs', `snapshot-${id.snapshotId}.json`), 'utf8'));
    expect(manifest.state).toBe('deleting');
    expect(await readFile(join(root, 'image-refs', manifest.quarantine, 'image'), 'utf8')).toBe('reviewed');
    expect(await readFile(join(root, 'image-refs', manifest.quarantine, 'anchor'), 'utf8')).toBe('reviewed');
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
  });

  it('pins and retains the original when the anchor changes during collection', async () => {
    const id = await stageReviewedReference(randomUUID(), source, digest);
    await markSnapshotState(id, 'settled');
    const anchor = join(root, 'image-refs', `snapshot-${id.snapshotId}.anchor`);
    onDeletionIntent = async () => {
      await unlink(anchor);
      await writeFile(anchor, 'reviewed');
    };
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
    const manifest = JSON.parse(await readFile(join(root, 'image-refs', `snapshot-${id.snapshotId}.json`), 'utf8'));
    const directory = join(root, 'image-refs', manifest.quarantine);
    const original = await lstat(join(directory, 'image'), { bigint: true });
    const replacement = await lstat(join(directory, 'anchor'), { bigint: true });
    expect({ dev: String(original.dev), ino: String(original.ino) }).toEqual({ dev: id.dev, ino: id.ino });
    expect({ dev: String(replacement.dev), ino: String(replacement.ino) }).not.toEqual({ dev: id.dev, ino: id.ino });
    expect(await readFile(join(directory, 'image'), 'utf8')).toBe('reviewed');
    expect(await readFile(join(directory, 'anchor'), 'utf8')).toBe('reviewed');
  });

  it('holds legacy records without an anchor rather than adopting or collecting them', async () => {
    const id = await stageReviewedReference(randomUUID(), source, digest);
    const manifest = join(root, 'image-refs', `snapshot-${id.snapshotId}.json`);
    const { anchorVersion: _anchorVersion, ...legacy } = id;
    await unlink(join(root, 'image-refs', `snapshot-${id.snapshotId}.anchor`));
    await writeFile(manifest, JSON.stringify({ ...legacy, state: 'settled' }));
    await expect(readOwnedSnapshot(legacy)).rejects.toMatchObject({ code: 'REVIEWED_REFERENCE_CHANGED' });
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
    expect(await readFile(join(root, 'image-refs', id.filename), 'utf8')).toBe('reviewed');
  });

  it('preserves an incomplete reservation without identity proof', async () => {
    const id = randomUUID();
    const directory = join(root, 'image-refs');
    await mkdir(directory, { recursive: true });
    const filename = `snapshot-${id}.png`;
    await writeFile(join(directory, filename), 'partial');
    await writeFile(join(directory, `snapshot-${id}.json`), JSON.stringify({ snapshotId: id, filename, state: 'reserved' }));
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
    expect(await readFile(join(directory, filename), 'utf8')).toBe('partial');
  });

  it('preserves reserved copies while a durable queued job owns them', async () => {
    const id = await stageReviewedReference(randomUUID(), source, digest);
    await writeFile(join(root, 'media-jobs.json'), JSON.stringify({ jobs: [{ id: id.jobId, status: 'queued', params: {} }] }));
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
    await writeFile(join(root, 'media-jobs.json'), JSON.stringify({ jobs: [] }));
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 1 });
  });
});
