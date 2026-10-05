/**
 * Music Video render and document commits against a backup cut (#9982), over
 * the real project store and real files. Each workflow writes its bytes in
 * place first (the encoder's MP4, the publishing kit's encodes, a composition
 * document's version folder), so the row that first names them must not commit
 * while a cut is open, and a cut must drain one already committing.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-backup-admission-'),
}));
vi.mock('../../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission: () => {} }));
vi.mock('./productionReview.js', async (load) => ({ ...await load(), assertProductionApproval: vi.fn() }));
// The publishing kit's encodes and thumbnails are written as placeholders; the
// final render's poster is a fixed name.
vi.mock('../../lib/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal()),
  generateThumbnail: vi.fn(async () => 'thumb.jpg'),
  findFfmpeg: vi.fn(async () => 'ffmpeg'),
  runFfmpegProcess: vi.fn(async ({ args }) => {
    await writeFile(args.at(-1), 'synthetic encode');
    return { ok: true };
  }),
}));
vi.mock('../instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'instance-test') }));
vi.mock('../videoGen/local.js', () => ({ loadHistory: vi.fn(async () => []), mutateVideoHistory: vi.fn(async () => {}) }));
vi.mock('./codeRender.js', async (importOriginal) => ({ ...(await importOriginal()), writeCodeProofSheet: vi.fn(async () => null) }));
vi.mock('./documentRender.js', async (importOriginal) => ({
  ...(await importOriginal()),
  encodeDocumentComposition: vi.fn(async ({ plan, outputPath }) => {
    await writeFile(outputPath, 'synthetic render');
    return { width: plan.width, height: plan.height, fps: 24, durationSec: plan.durationSec, startSec: 0, boundaryTimes: [0] };
  }),
}));

const { PATHS } = await import('../../lib/paths.js');
const projects = await import('./projects.js');
const { renderMusicVideo } = await import('./render.js');
const { startExcerptRender } = await import('./excerptRender.js');
const { importDocumentTemplate } = await import('./compositionDocument.js');
const { startPublishKitBuild } = await import('./publishKit.js');
const { encodeDocumentComposition } = await import('./documentRender.js');
const { runFfmpegProcess } = await import('../../lib/ffmpeg.js');
const { mutateVideoHistory } = await import('../videoGen/local.js');
const { saveHistory } = await import('../videoGen/history.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');

afterAll(() => cleanupTempDataRoots());

// Long enough for an unadmitted commit's file-backed project write to land, so
// a workflow still parked afterwards is parked on the cut.
const settleSeveral = () => new Promise(resolve => setTimeout(resolve, 100));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function documentProject() {
  await mkdir(PATHS.music, { recursive: true });
  await writeFile(join(PATHS.music, 'song.wav'), Buffer.alloc(64));
  const created = await projects.createProject({ name: 'Example Song', uploadedAudioFilename: 'song.wav', composition: { mode: 'document' } });
  await projects.mutateProjectRecord(created.id, (current) => ({ project: { ...current, audioAnalysis: { durationSec: 12.5, beats: [], downbeats: [], sections: [] } } }));
  await importDocumentTemplate(created.id);
  return created.id;
}

describe('final render', () => {
  it('drains a render whose history entry is committing until the project row names it', async () => {
    const id = await documentProject();
    const held = deferred();
    const proceed = deferred();
    mutateVideoHistory.mockImplementationOnce(async () => { held.resolve(); await proceed.promise; });
    const { jobId } = await renderMusicVideo(id);
    await held.promise;
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
    try {
      await settleSeveral();
      expect(cutReady, 'cut acquired while the render was still committing').toBe(false);
      proceed.resolve();
      await cut;
      // Everything the cut dumps names bytes its copy already saw.
      expect((await projects.getProject(id)).renderHistoryId).toBe(jobId);
    } finally {
      proceed.resolve();
      (await cut)();
    }
  });

  it('files a render that finishes during a cut only after the cut is released', async () => {
    const id = await documentProject();
    mutateVideoHistory.mockClear();
    encodeDocumentComposition.mockClear();
    const release = await acquireBackupSnapshotCut();
    try {
      const { jobId } = await renderMusicVideo(id);
      await vi.waitFor(() => expect(encodeDocumentComposition).toHaveBeenCalledOnce());
      await settleSeveral();
      expect(mutateVideoHistory).not.toHaveBeenCalled();
      expect((await projects.getProject(id)).renderHistoryId ?? null).toBeNull();
      release();
      await vi.waitFor(async () => expect((await projects.getProject(id)).renderHistoryId).toBe(jobId));
    } finally {
      release();
    }
  });
});

describe('draft excerpt render', () => {
  it('keeps a finished excerpt rendering until the cut is released', async () => {
    const id = await documentProject();
    encodeDocumentComposition.mockClear();
    const release = await acquireBackupSnapshotCut();
    try {
      const { excerptId } = await startExcerptRender(id, { startSec: 1, endSec: 3 });
      await vi.waitFor(() => expect(encodeDocumentComposition).toHaveBeenCalledOnce());
      await settleSeveral();
      const pending = (await projects.getProject(id)).excerpts.find(e => e.id === excerptId);
      expect(pending).toMatchObject({ status: 'rendering', filename: null });
      release();
      await vi.waitFor(async () => {
        const excerpt = (await projects.getProject(id)).excerpts.find(e => e.id === excerptId);
        expect(excerpt.status).toBe('complete');
        expect(existsSync(join(PATHS.videos, excerpt.filename))).toBe(true);
      });
    } finally {
      release();
    }
  });
});

describe('composition document import', () => {
  it('writes the version folder but names it on the project only after the cut', async () => {
    const id = await documentProject();
    const before = (await projects.getProject(id)).composition.document.directory;
    const root = join(PATHS.data, 'music-video', id, 'composition');
    const release = await acquireBackupSnapshotCut();
    try {
      const importing = importDocumentTemplate(id);
      await vi.waitFor(async () => expect((await readdir(root)).filter(name => !name.startsWith('.'))).toHaveLength(2));
      await settleSeveral();
      expect((await projects.getProject(id)).composition.document.directory).toBe(before);
      release();
      const { document } = await importing;
      expect(document.directory).not.toBe(before);
      expect((await projects.getProject(id)).composition.document.directory).toBe(document.directory);
    } finally {
      release();
    }
  });
});

describe('publishing kit build', () => {
  it('names freshly encoded kit files on the project only after the cut', async () => {
    const id = await documentProject();
    await mkdir(PATHS.videos, { recursive: true });
    await writeFile(join(PATHS.videos, 'master-example.mp4'), 'synthetic master');
    await saveHistory([{ id: 'render-example', filename: 'master-example.mp4', durationSec: 12.5 }]);
    await projects.mutateProjectRecord(id, current => ({ project: { ...current, renderHistoryId: 'render-example' } }));
    runFfmpegProcess.mockClear();
    const release = await acquireBackupSnapshotCut();
    try {
      await startPublishKitBuild(id);
      // Thumbnails are the build's last ffmpeg step.
      await vi.waitFor(async () => expect((await readdir(PATHS.videoThumbnails)).some(name => name.endsWith('-thumb-6.jpg'))).toBe(true));
      await settleSeveral();
      const encoded = runFfmpegProcess.mock.calls.length;
      expect(encoded).toBeGreaterThan(6);
      expect((await projects.getProject(id)).publishKit?.exports).toBeUndefined();
      release();
      await vi.waitFor(async () => expect((await projects.getProject(id)).publishKit?.exports?.length).toBe(encoded - 6));
      for (const { filename } of (await projects.getProject(id)).publishKit.exports) {
        expect(existsSync(join(PATHS.videos, filename))).toBe(true);
      }
    } finally {
      release();
    }
  });
});
