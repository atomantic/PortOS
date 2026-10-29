import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, rename, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root;
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return { ...actual, PATHS: new Proxy({}, { get: (_, key) => key === 'data' ? root : key === 'imageRefs' ? join(root, 'image-refs') : key === 'images' ? join(root, 'images') : actual.PATHS[key] }) };
});
const { stageReviewedReference, markSnapshotState, readOwnedSnapshot } = await import('./reviewedReference.js');
const { sweepReviewedReferences } = await import('./reviewedReferenceGc.js');
const digest = createHash('sha256').update('reviewed').digest('hex');
const future = Date.now() + 8 * 24 * 60 * 60 * 1000;
let source;

beforeEach(async () => {
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

  it('finishes an interrupted deletion only with its persisted deletion intent', async () => {
    const id = await stageReviewedReference(randomUUID(), source, digest);
    const manifest = join(root, 'image-refs', `snapshot-${id.snapshotId}.json`);
    await markSnapshotState(id, 'settled');
    await writeFile(manifest, JSON.stringify({ ...id, state: 'deleting' }));
    await unlink(join(root, 'image-refs', id.filename));
    expect(await sweepReviewedReferences({ now: future })).toEqual({ deleted: 0 });
    await expect(readFile(manifest)).rejects.toMatchObject({ code: 'ENOENT' });
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
