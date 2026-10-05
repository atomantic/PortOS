/**
 * Code Animation file-plus-row workflows against a backup cut (#9982). Each
 * writes its bytes (generated HTML, a write-once revision tree, run artifacts,
 * a published MP4) before the row that first names them, so that row commits
 * under the admission lease: a cut that arrives mid-commit drains it, and a
 * commit that arrives during a cut waits until the cut is released. Providers,
 * renders and the database are doubled; revision and run files are real.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async importOriginal =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('code-animation-backup-') }));
vi.mock('../../lib/databaseMaintenanceJournal.js', async importOriginal => ({
  ...(await importOriginal()),
  assertDatabaseAdmission: () => {},
}));
vi.mock('../socket.js', () => ({ emitCodeAnimationChanged: vi.fn() }));
const store = vi.hoisted(() => ({
  getProjectRecord: vi.fn(), getRevisionRecord: vi.fn(), startImportRecord: vi.fn(), commitImportRecord: vi.fn(),
  failImportRecord: vi.fn(), startStageRun: vi.fn(), saveStageRun: vi.fn(), reserveRunBytes: vi.fn(),
  commitRepairRevision: vi.fn(),
}));
vi.mock('./projectStore.js', () => store);
const jobs = vi.hoisted(() => ({ saveCodeAnimationJobRecord: vi.fn(), saveCodeAnimationHtml: vi.fn() }));
vi.mock('./jobStore.js', async importOriginal => ({ ...(await importOriginal()), ...jobs }));
vi.mock('../providers.js', () => ({ getProviderById: vi.fn(async () => ({ id: 'example-provider', type: 'api', enabled: true })) }));
vi.mock('../promptRunner.js', () => ({
  runPromptThroughProvider: vi.fn(async () => ({ text: '```html\n<!doctype html><html><canvas></canvas></html>\n```' })),
}));
vi.mock('../creativeStyleSources.js', () => ({
  resolveUniverseStyleSource: vi.fn(async () => null),
  resolveMoodBoardStyleSource: vi.fn(async () => ({ board: null, images: [] })),
}));
const history = vi.hoisted(() => ({ mutateVideoHistory: vi.fn() }));
vi.mock('../videoGen/history.js', () => history);
vi.mock('../../lib/ffmpeg.js', async importOriginal => ({
  ...(await importOriginal()),
  generateThumbnail: vi.fn(async (_path, id) => `${id}.jpg`),
  findFfprobe: vi.fn(async () => null),
}));
const mux = vi.hoisted(() => ({ installed: false }));
vi.mock('../pipeline/audioMux.js', () => ({
  muxVoLines: vi.fn(async (_video, { withInstall }) => withInstall(async () => { mux.installed = true; return { ok: true }; })),
}));

const { PATHS } = await import('../../lib/paths.js');
const { createCodeAnimationPackage } = await import('../../lib/codeAnimationPackage.js');
const { codeAnimationBudgetsSchema } = await import('../../lib/codeAnimationProjects.js');
const { soundTimeline } = await import('../../lib/codeAnimationSound.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
const { sourceHashOf, stageProjectFiles, writeRunArtifact } = await import('./projectFiles.js');
const { startCodeAnimationGeneration } = await import('./index.js');
const { importProductionPackage } = await import('./projects.js');
const { startProductionStageRun } = await import('./stages.js');
const { publishBlenderVideo } = await import('./blenderRender.js');
const { muxSoundtrack } = await import('./sound.js');

afterAll(() => cleanupTempDataRoots('code-animation-backup-'));

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

/** Each doubled commit reports its name and arguments here before it settles. */
let hold = null;
const holdable = (name, result) => async (...args) => {
  await hold?.(name, ...args);
  return typeof result === 'function' ? result(...args) : result;
};

/**
 * Pause a workflow at the commit `matches` selects, request a cut, and prove
 * the cut is granted only after that commit settles.
 */
async function expectCutDrainsCommit(start, matches) {
  let reachedCommit;
  const reached = new Promise(resolve => { reachedCommit = resolve; });
  let finishCommit;
  const commitDone = new Promise(resolve => { finishCommit = resolve; });
  hold = async (...args) => {
    if (!matches(...args)) return;
    hold = null;
    reachedCommit();
    await commitDone;
  };
  const pending = start();
  await reached;
  let cutReady = false;
  const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
  try {
    await settle();
    expect(cutReady, 'cut granted while a row naming new bytes was committing').toBe(false);
  } finally {
    finishCommit();
    (await cut)();
  }
  return pending;
}

const manifest = () => ({
  title: 'Synthetic film', brief: { concept: 'A cube hops over a cone.', cast: '', onScreenText: '' },
  styleGuide: 'Graphic shapes', renderer: { kind: 'browser', version: 'synthetic-v1', engine: null },
  format: { width: 1280, height: 720, fps: 12, durationSeconds: 4 }, seed: 1,
  entrypoints: [{ role: 'preview', path: 'src/index.html' }], assets: [], shots: [], events: [],
  audio: { kind: 'silence' }, execution: { requested: null, effective: null },
});
const pkg = source => createCodeAnimationPackage(manifest(), [{ path: 'src/index.html', content: source }]);
const PROJECT_ID = 'example-project';

/** A revision whose write-once tree is really staged under the temp data root. */
async function stagedRevision(source) {
  const built = pkg(source);
  const id = randomUUID();
  const storage = await stageProjectFiles(PROJECT_ID, id, built.files);
  return {
    id, packageHash: built.revisionHash, sourceHash: sourceHashOf(built.files),
    totalBytes: built.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
    schemaVersion: built.schemaVersion, manifest: built.manifest,
    files: built.files.map(({ content: _content, ...file }) => file), storage, createdAt: new Date().toISOString(),
  };
}

// A FROZEN film fails inspection, so a run repairs it into a MOVING revision.
const sample = async (directory, { times, captureTimes = [] }) => {
  const html = await readFile(join(PATHS.data, directory, 'index.html'), 'utf8');
  const hash = t => createHash('sha256').update(html.includes('FROZEN') ? 'same' : `t${t}`).digest('hex');
  return {
    contract: { durationSec: 4, fps: 12, width: 1280, height: 720 },
    samples: times.map(t => ({ t, renderHash: hash(t), mean: 80, deviation: 20 })),
    frames: captureTimes.map(t => ({ t, bytes: Buffer.from(`png-${t}`) })),
  };
};
const repair = async ({ files, entryPath }) => ({
  files: [{ path: entryPath, content: files.find(file => file.path === entryPath).content.replace('FROZEN', 'MOVING') }], tokens: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  hold = null;
  mux.installed = false;
  const project = { id: PROJECT_ID, budgets: codeAnimationBudgetsSchema.parse({}), localSettings: {} };
  store.getProjectRecord.mockResolvedValue(project);
  store.startImportRecord.mockResolvedValue(true);
  store.commitImportRecord.mockImplementation(holdable('commitImportRecord', project));
  store.startStageRun.mockResolvedValue();
  store.saveStageRun.mockImplementation(holdable('saveStageRun'));
  store.reserveRunBytes.mockResolvedValue(true);
  store.commitRepairRevision.mockImplementation(holdable('commitRepairRevision', project));
  jobs.saveCodeAnimationJobRecord.mockImplementation(holdable('saveCodeAnimationJobRecord', job => job));
  jobs.saveCodeAnimationHtml.mockResolvedValue();
  history.mutateVideoHistory.mockImplementation(holdable('mutateVideoHistory'));
});

describe('Code Animation workflows and a backup cut', () => {
  it('drains a cut behind the completed generation row that names its HTML', async () => {
    const completed = new Promise(resolve => {
      jobs.saveCodeAnimationJobRecord.mockImplementation(holdable('saveCodeAnimationJobRecord', job => { if (job.status === 'completed') resolve(); return job; }));
    });
    await expectCutDrainsCommit(() => startCodeAnimationGeneration({
      providerId: 'example-provider', concept: 'A cube hops over a cone.',
      format: { aspectRatio: '16:9', resolution: '720p', fps: 24, durationSeconds: 4 },
    }), (name, job) => name === 'saveCodeAnimationJobRecord' && job.status === 'completed');
    await completed;
    expect(jobs.saveCodeAnimationHtml).toHaveBeenCalledTimes(1);
  });

  it('writes no generated HTML while a cut is held', async () => {
    const release = await acquireBackupSnapshotCut();
    try {
      await startCodeAnimationGeneration({
        providerId: 'example-provider', concept: 'A cube hops over a cone.',
        format: { aspectRatio: '16:9', resolution: '720p', fps: 24, durationSeconds: 4 },
      });
      await settle();
      expect(jobs.saveCodeAnimationHtml).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await vi.waitFor(() => expect(jobs.saveCodeAnimationJobRecord).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' })));
    expect(jobs.saveCodeAnimationHtml).toHaveBeenCalledTimes(1);
  });

  it('drains a cut behind the revision row that names an imported package tree', async () => {
    const result = await expectCutDrainsCommit(() => importProductionPackage(PROJECT_ID, pkg('<html><canvas></canvas>MOVING</html>')),
      name => name === 'commitImportRecord');
    const [, revision] = store.commitImportRecord.mock.calls[0];
    expect(result.revision.id).toBe(revision.id);
    await expect(readFile(join(PATHS.data, revision.storage.relativePath, 'src/index.html'), 'utf8')).resolves.toContain('MOVING');
  });

  it.each([
    ['the run row that first names style frames',
      (name, _id, _status, data) => name === 'saveStageRun' && data.stages.some(stage => stage.key === 'style-frame' && stage.artifacts?.length)],
    ['the repaired revision row', name => name === 'commitRepairRevision'],
  ])('drains a cut behind %s', async (_name, matches) => {
    const revision = await stagedRevision('<html><canvas></canvas>FROZEN</html>');
    store.getRevisionRecord.mockResolvedValue(revision);
    const render = vi.fn(async () => ({ jobId: 'media-job', id: 'video-1', filename: 'composition-media-job.mp4' }));
    let done;
    await expectCutDrainsCommit(async () => {
      ({ done } = await startProductionStageRun(PROJECT_ID, { revisionId: revision.id }, { sample, repair, render }));
    }, matches);
    await expect(done).resolves.toBe('completed');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('drains a cut behind the history entry that publishes a Blender film', async () => {
    const source = join(PATHS.data, 'code-animations', 'example-sequence.mp4');
    await mkdir(join(PATHS.data, 'code-animations'), { recursive: true });
    await writeFile(source, Buffer.from('mp4'));
    const published = await publishBlenderVideo(
      { sequence: { artifact: { relativePath: 'code-animations/example-sequence.mp4' }, geometry: { width: 1280, height: 720 } }, renderer: {}, artifacts: [] },
      { revision: { id: 'rev', sourceHash: 'hash', manifest: manifest() }, reserve: async () => {} },
    );
    await expectCutDrainsCommit(() => published.commit(), name => name === 'mutateVideoHistory');
    await expect(readFile(join(PATHS.videos, published.filename), 'utf8')).resolves.toBe('mp4');
  });

  it('installs a muxed soundtrack over a published film only outside a cut', async () => {
    const runId = randomUUID();
    const revision = { id: randomUUID(), packageHash: 'pkg', manifest: { ...manifest(), audio: { kind: 'procedural', version: 1, events: [] } } };
    const name = `sound-${revision.id}.wav`;
    const artifact = await writeRunArtifact(PROJECT_ID, runId, name, Buffer.alloc(64, 1));
    await mkdir(PATHS.videos, { recursive: true });
    await writeFile(join(PATHS.videos, 'example-film.mp4'), Buffer.from('mp4'));
    const soundtrack = {
      kind: 'procedural', revisionId: revision.id, packageHash: 'pkg', timelineHash: soundTimeline(revision.manifest).hash,
      timeline: soundTimeline(revision.manifest), artifact: { ...artifact, runId, name },
    };
    const release = await acquireBackupSnapshotCut();
    let pending;
    try {
      pending = muxSoundtrack({ projectId: PROJECT_ID, revision, soundtrack, result: { filename: 'example-film.mp4' }, signal: new AbortController().signal });
      await settle();
      expect(mux.installed).toBe(false);
    } finally {
      release();
    }
    // The doubled ffprobe is absent, so verification refuses after the install.
    await expect(pending).rejects.toMatchObject({ code: 'CODE_ANIMATION_SOUND_UNVERIFIED' });
    expect(mux.installed).toBe(true);
  });
});
