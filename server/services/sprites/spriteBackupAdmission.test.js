/**
 * Sprite workflows against a backup cut (#9982). A snapshot copies files and then
 * dumps rows, so the sprite row (status, frozen chroma key) must never be dumped
 * next to files from before the workflow that wrote it. Every workflow that pairs
 * a manifest, walk set or imported tree with its sprite row holds one admission
 * lease from its first byte through the row. The suites hold the row write at
 * its commit seam over real files: a cut requested mid-workflow must wait for
 * it, and a workflow requested mid-cut must not change a byte until the cut ends.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { capSharpThreads, lockAllAnchors, placeCandidate as placeCandidateFixture } from './spriteTestFixtures.js';

const restoreSharpThreads = capSharpThreads();
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-backup-admission-'));
afterAll(() => {
  restoreSharpThreads();
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// The file record backend writes every row through atomicWrite, so holding that
// write holds the row commit.
let beforeRowWrite = async () => {};
vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, {
    data: TEST_ROOT,
    sprites: join(TEST_ROOT, 'sprites'),
    images: join(TEST_ROOT, 'images'),
    videos: join(TEST_ROOT, 'videos'),
  });
  return {
    ...actual,
    atomicWrite: async (path, ...args) => {
      if (path.endsWith('sprite-records.json')) await beforeRowWrite();
      return actual.atomicWrite(path, ...args);
    },
  };
});

const executeTuiRun = vi.fn(() => new Promise(() => {}));
vi.mock('../tuiPromptRunner.js', () => ({ executeTuiRun: (...args) => executeTuiRun(...args) }));
vi.mock('../../lib/imageCleanDefaults.js', () => ({ resolveImageCleaners: () => ({ cleanC2PA: false, denoise: false }) }));
vi.mock('../settings.js', () => ({
  getSettings: async () => ({ imageGen: { mode: 'grok', grok: { enabled: true, grokPath: '/usr/local/bin/grok' } } }),
}));
vi.mock('../../lib/ffmpeg.js', async (importOriginal) => ({
  ...await importOriginal(),
  probeVideoDuration: async () => null,
}));
const runWalkPostprocess = vi.fn(async ({ runRel, runAbs, recordId, direction, frameCount = 8, fps = 12 }) => {
  await mkdir(join(runAbs, 'generated'), { recursive: true });
  await writeFile(join(runAbs, 'generated', 'strip.png'), 'packaged-strip-bytes');
  await writeFile(join(runAbs, 'generated', 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'deterministically-packaged-grok-walk-video',
    characterId: recordId,
    direction,
    frameCount,
    frameRate: fps,
    stripPath: `${runRel}/generated/strip.png`,
    stripSha256: createHash('sha256').update(Buffer.from('packaged-strip-bytes')).digest('hex'),
  }));
  return {
    manifest: { frameCount, frameRate: fps },
    manifestPath: `${runRel}/generated/manifest.json`,
    stripPreview: { stripPath: `${runRel}/generated/strip.png`, frameCount, fps, cellWidth: 384, cellHeight: 384, row: 0, startColumn: 0 },
  };
});
vi.mock('./walkPostprocess.js', async (importOriginal) => ({
  ...await importOriginal(),
  prepareWalkAnchorChromaInput: async (_anchorAbs, destAbs) => {
    await mkdir(join(destAbs, '..'), { recursive: true });
    await writeFile(destAbs, 'stub-chroma-anchor');
    return { preparation: 'composited-over-solid-chroma-matte', canvas: null };
  },
  runWalkPostprocess: (...args) => runWalkPostprocess(...args),
}));
vi.mock('../mediaJobQueue/index.js', async (importOriginal) => ({
  ...await importOriginal(),
  enqueueJob: () => ({ jobId: 'job-1', position: 0, status: 'queued' }),
}));

const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
const records = await import('./records.js');
const { buildSpriteRecord } = await import('./recordsLogic.js');
const {
  lockReference, unlockReferenceAnchor, unlockReferenceMain, unlockReferenceTurnaround,
} = await import('./reference.js');
const {
  approveWalkDirection, unlockWalkSet, reopenWalkDirection, invalidateWalkDirectionForAnchorRevision,
  unlockTurnaroundReference, startWalkGeneration,
} = await import('./walk.js');
const { startTrackGeneration } = await import('./animationTrackWorkflow.js');
const { importFromSource } = await import('./importer.js');
const { SPRITE_DIRECTIONS, ANCHOR_DIRECTIONS } = await import('./prompts.js');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const exists = (path) => stat(path).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const spritePath = (id, rel) => join(TEST_ROOT, 'sprites', id, rel);
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

/** Hold the next sprite row write; resolves `reached` once the workflow is parked on it. */
function holdRowWrite() {
  const reached = deferred();
  const commit = deferred();
  beforeRowWrite = async () => {
    beforeRowWrite = async () => {};
    reached.resolve();
    await commit.promise;
  };
  return { reached: reached.promise, commit: commit.resolve };
}

/** Request a cut and report whether it was granted yet. */
function requestCut() {
  const state = { granted: false, release: null };
  state.promise = acquireBackupSnapshotCut().then((release) => {
    state.granted = true;
    state.release = release;
    return release;
  });
  return state;
}

let seq = 0;
const newId = () => `sprite-${++seq}`;

async function lockedCharacter(directions = ['east']) {
  const id = newId();
  await records.createRecord({ kind: 'character', name: 'Example' }, id);
  await lockAllAnchors(TEST_ROOT, id, { lockReference, directions, records });
  return id;
}

async function makeCandidateRun(recordId, direction) {
  const runId = `walk-${direction}-${(seq++).toString(16).padStart(8, '0')}`;
  const runDir = join(TEST_ROOT, 'sprites', recordId, 'runs', runId, 'generated');
  await mkdir(runDir, { recursive: true });
  const stripName = `${recordId}-walk-${direction}-strip.png`;
  await writeFile(join(runDir, stripName), `strip-${direction}`);
  const manifestRel = `runs/${runId}/generated/${recordId}-walk-${direction}-manifest.json`;
  await writeFile(spritePath(recordId, manifestRel), JSON.stringify({
    schemaVersion: 1,
    kind: 'deterministically-packaged-grok-walk-video',
    characterId: recordId,
    direction,
    frameRate: 12,
    frameCount: 8,
    stripPath: `runs/${runId}/generated/${stripName}`,
    stripSha256: createHash('sha256').update(Buffer.from(`strip-${direction}`)).digest('hex'),
  }));
  await writeFile(spritePath(recordId, `runs/${runId}/animation-run.json`), JSON.stringify({
    schemaVersion: 1,
    kind: 'grok-game-animation-frames-run',
    status: 'candidate',
    id: runId,
    characterId: recordId,
    direction,
    chromaKey: '#FF00FF',
    createdAt: new Date().toISOString(),
    postprocessManifest: manifestRel,
    sourceVideoPath: `runs/${runId}/generated/source-video.mp4`,
    stripPreview: { stripPath: `runs/${runId}/generated/${stripName}`, frameCount: 8, fps: 12, cellWidth: 384, cellHeight: 384, row: 0, startColumn: 0 },
  }));
  return runId;
}

const approveDirections = async (id, directions) => {
  for (const direction of directions) {
    // eslint-disable-next-line no-await-in-loop -- each approval rewrites the shared selection file
    await approveWalkDirection(id, { direction, runId: await makeCandidateRun(id, direction) });
  }
};

async function finalizedCharacter() {
  const id = await lockedCharacter(ANCHOR_DIRECTIONS);
  await approveDirections(id, SPRITE_DIRECTIONS);
  expect((await records.getRecord(id)).status).toBe('walk-complete');
  return id;
}

beforeEach(() => {
  beforeRowWrite = async () => {};
  executeTuiRun.mockReset();
  executeTuiRun.mockImplementation(() => new Promise(() => {}));
  runWalkPostprocess.mockClear();
});

/**
 * One in-flight workflow, parked after its files changed and before its row
 * commits: a cut requested now must wait for the workflow and only then be
 * granted, so the dump that follows the file copy sees the finished pair.
 */
async function expectCutDrainsWorkflow({ start, filesChanged, committed }) {
  const hold = holdRowWrite();
  const running = start();
  running.catch(() => {}); // surfaced by the await below; never left unhandled if an assertion throws first
  let cut;
  try {
    await Promise.race([hold.reached, running.then(() => { throw new Error('workflow ended before its row write'); })]);
    await filesChanged();
    cut = requestCut();
    await settle();
    expect(cut.granted).toBe(false);
    hold.commit();
    // A workflow may take a second lease after the first (a revision, then the
    // unlock); it is admitted again only once the cut is released.
    await cut.promise;
    await committed();
  } finally {
    hold.commit();
    cut?.promise.then((release) => release(), () => {});
  }
  await running;
}

/** A workflow requested during a cut must change no byte until the cut is released. */
async function expectWorkflowWaitsOutCut({ start, untouched, applied }) {
  const release = await acquireBackupSnapshotCut();
  let running;
  try {
    running = start();
    running.catch(() => {});
    await settle();
    await untouched();
  } finally {
    release();
  }
  await running;
  await applied();
}

describe('reference lock and unlock', () => {
  it('drains an in-flight turnaround lock before a cut is granted', async () => {
    const id = newId();
    await records.createRecord({ kind: 'character', name: 'Example' }, id);
    const candidate = await placeCandidateFixture(TEST_ROOT, id, 'turnaround', 'turnaround-candidate-01.png');
    await expectCutDrainsWorkflow({
      start: () => lockReference(id, { target: 'turnaround', candidate }),
      // The lock writes the frozen sheet first; the manifest names it only after the row.
      filesChanged: async () => {
        expect(await exists(spritePath(id, `reference/${id}-turnaround-v1.png`))).toBe(true);
        expect(await exists(spritePath(id, `reference/${id}-reference-set-v1.json`))).toBe(false);
      },
      committed: async () => {
        const manifest = await readJson(spritePath(id, `reference/${id}-reference-set-v1.json`));
        expect(manifest.turnaround.locked).toBe(true);
        expect((await records.getRecord(id)).status).toBe('reference');
      },
    });
  });

  it('writes no locked sheet while a cut is active', async () => {
    const id = newId();
    await records.createRecord({ kind: 'character', name: 'Example' }, id);
    const candidate = await placeCandidateFixture(TEST_ROOT, id, 'turnaround', 'turnaround-candidate-01.png');
    await expectWorkflowWaitsOutCut({
      start: () => lockReference(id, { target: 'turnaround', candidate }),
      untouched: async () => {
        expect(await exists(spritePath(id, `reference/${id}-turnaround-v1.png`))).toBe(false);
        expect((await records.getRecord(id)).status).toBe('draft');
      },
      applied: async () => {
        expect(await exists(spritePath(id, `reference/${id}-turnaround-v1.png`))).toBe(true);
        expect((await records.getRecord(id)).status).toBe('reference');
      },
    });
  });

  // The unlocks write the row first, then the manifest, so a cut parked on the row
  // still sees a locked manifest; the lease keeps the dump from pairing that
  // manifest with the already-downgraded row.
  it.each([
    ['anchor', (id) => unlockReferenceAnchor(id, { direction: 'east' }), (m) => m.anchors.find((a) => a.direction === 'east').status],
    ['main', (id) => unlockReferenceMain(id), (m) => (m.mainReference.locked ? 'locked' : 'pending')],
    ['turnaround', (id) => unlockReferenceTurnaround(id), (m) => (m.turnaround.locked ? 'locked' : 'pending')],
  ])('keeps a %s unlock whole across a cut', async (_name, unlock, manifestState) => {
    const id = await lockedCharacter(['east']);
    const manifestPath = (recordId) => spritePath(recordId, `reference/${recordId}-reference-set-v1.json`);
    const before = (await records.getRecord(id)).updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5)); // a distinct updatedAt millisecond
    await expectCutDrainsWorkflow({
      start: () => unlock(id),
      filesChanged: async () => expect(manifestState(await readJson(manifestPath(id)))).toBe('locked'),
      committed: async () => {
        expect(manifestState(await readJson(manifestPath(id)))).toBe('pending');
        expect((await records.getRecord(id)).updatedAt).not.toBe(before);
      },
    });
    const second = await lockedCharacter(['east']);
    const secondBefore = (await records.getRecord(second)).updatedAt;
    await expectWorkflowWaitsOutCut({
      start: () => unlock(second),
      untouched: async () => {
        expect(manifestState(await readJson(manifestPath(second)))).toBe('locked');
        expect((await records.getRecord(second)).updatedAt).toBe(secondBefore);
      },
      applied: async () => expect(manifestState(await readJson(manifestPath(second)))).toBe('pending'),
    });
  });
});

describe('walk set finalization and revision', () => {
  // Finalizing writes the walk set before the row, so a snapshot could pair a copy
  // without the set with a row that says walk-complete — the state its write order
  // exists to prevent.
  it('keeps the eighth approval whole across a cut', async () => {
    const id = await lockedCharacter(ANCHOR_DIRECTIONS);
    await approveDirections(id, SPRITE_DIRECTIONS.slice(0, 7));
    const last = SPRITE_DIRECTIONS[7];
    const runId = await makeCandidateRun(id, last);
    const walkSet = spritePath(id, `walk/${id}-walk-set-v1.json`);
    await expectCutDrainsWorkflow({
      start: () => approveWalkDirection(id, { direction: last, runId }),
      filesChanged: async () => expect(await exists(walkSet)).toBe(true),
      committed: async () => expect((await records.getRecord(id)).status).toBe('walk-complete'),
    });
  });

  it('writes no walk set while a cut is active', async () => {
    const id = await lockedCharacter(ANCHOR_DIRECTIONS);
    await approveDirections(id, SPRITE_DIRECTIONS.slice(0, 7));
    const last = SPRITE_DIRECTIONS[7];
    const runId = await makeCandidateRun(id, last);
    const walkSet = spritePath(id, `walk/${id}-walk-set-v1.json`);
    await expectWorkflowWaitsOutCut({
      start: () => approveWalkDirection(id, { direction: last, runId }),
      untouched: async () => {
        expect(await exists(walkSet)).toBe(false);
        expect((await records.getRecord(id)).status).toBe('reference-complete');
      },
      applied: async () => expect(await exists(walkSet)).toBe(true),
    });
  });

  // Each of these removes the finalized set and then downgrades the row: a snapshot
  // that copied the set earlier must not dump the downgraded row.
  it.each([
    ['unlockWalkSet', (id) => unlockWalkSet(id, { acknowledgeNoClips: true })],
    ['reopenWalkDirection', (id) => reopenWalkDirection(id, { direction: 'east', acknowledgeNoClips: true })],
    ['invalidateWalkDirectionForAnchorRevision', (id) => invalidateWalkDirectionForAnchorRevision(id, { direction: 'east' })],
    ['unlockTurnaroundReference', (id) => unlockTurnaroundReference(id)],
  ])('keeps %s whole across a cut', async (_name, workflow) => {
    const id = await finalizedCharacter();
    const walkSet = spritePath(id, `walk/${id}-walk-set-v1.json`);
    await expectCutDrainsWorkflow({
      start: () => workflow(id),
      filesChanged: async () => expect(await exists(walkSet)).toBe(false),
      committed: async () => expect((await records.getRecord(id)).status).not.toBe('walk-complete'),
    });
    const second = await finalizedCharacter();
    await expectWorkflowWaitsOutCut({
      start: () => workflow(second),
      untouched: async () => {
        expect(await exists(spritePath(second, `walk/${second}-walk-set-v1.json`))).toBe(true);
        expect((await records.getRecord(second)).status).toBe('walk-complete');
      },
      applied: async () => expect(await exists(spritePath(second, `walk/${second}-walk-set-v1.json`))).toBe(false),
    });
  });
});

describe('grok TUI attach lane', () => {
  // The terminal session runs outside admission and writes the clip itself; the
  // attach that packages its frames and files the run record is the publication.
  it.each([
    ['walk', (id) => startWalkGeneration(id, { direction: 'east' })],
    ['scanner track', (id) => startTrackGeneration('scanner', id, { direction: 'east' })],
  ])('packages a %s clip and files its run only outside a cut', async (_name, start) => {
    const id = await lockedCharacter(['east']);
    const clipWritten = deferred();
    const sessionEnds = deferred();
    executeTuiRun.mockImplementationOnce(async ({ workspacePath }) => {
      await writeFile(join(workspacePath, 'source-video.mp4'), 'grok-clip-bytes');
      clipWritten.resolve();
      await sessionEnds.promise;
    });
    const { runId } = await start(id);
    await clipWritten.promise;
    const runStatus = async () => (await readJson(spritePath(id, `runs/${runId}/animation-run.json`))).status;

    const release = await acquireBackupSnapshotCut();
    try {
      sessionEnds.resolve();
      await settle();
      expect(runWalkPostprocess).not.toHaveBeenCalled();
      expect(await runStatus()).toBe('rendering');
    } finally {
      release();
    }
    await vi.waitFor(async () => expect(await runStatus()).toBe('candidate'));
    expect(runWalkPostprocess).toHaveBeenCalledOnce();
  });
});

describe('source-pipeline import', () => {
  const sourceRoot = () => join(TEST_ROOT, 'source-pipeline');
  // A character subject carries a spec; a props family is a directory of atlas images.
  const SUBJECTS = [
    {
      name: 'character',
      async write(id) {
        await mkdir(join(sourceRoot(), 'art-pipeline', 'characters'), { recursive: true });
        await writeFile(
          join(sourceRoot(), 'art-pipeline', 'characters', `${id}.json`),
          JSON.stringify({ characterId: id, displayName: 'Example Importee' }),
        );
      },
      imported: (id) => spritePath(id, 'character-spec.json'),
    },
    {
      name: 'props family',
      async write(id) {
        await mkdir(join(sourceRoot(), 'game', 'assets', 'sprites', id), { recursive: true });
        await writeFile(join(sourceRoot(), 'game', 'assets', 'sprites', id, 'props.png'), 'synthetic atlas');
      },
      imported: (id) => spritePath(id, 'atlas/props.png'),
    },
  ];
  const run = (id) => importFromSource({ sourceRoot: sourceRoot(), characters: [id], includeProps: true });

  it.each(SUBJECTS)('drains an in-flight $name import before a cut is granted', async ({ write, imported }) => {
    const id = newId();
    await write(id);
    await expectCutDrainsWorkflow({
      start: () => run(id),
      filesChanged: async () => expect(await exists(imported(id))).toBe(true),
      committed: async () => expect((await records.getRecord(id)).status).toBe('imported'),
    });
  });

  it.each(SUBJECTS)('copies no $name file while a cut is active', async ({ write, imported }) => {
    const id = newId();
    await write(id);
    await expectWorkflowWaitsOutCut({
      start: () => run(id),
      untouched: async () => {
        expect(await exists(imported(id))).toBe(false);
        expect(await records.getRecord(id)).toBeNull();
      },
      applied: async () => expect((await records.getRecord(id)).status).toBe('imported'),
    });
  });
});

// The DB sprite row remains metadata-only. Adjacent file-primary records still
// name bytes and are separately admitted by the shared animation/reference tails.
describe('sprite row contents', () => {
  it('holds metadata and workflow state only, never a data/ path', () => {
    const record = buildSpriteRecord({ name: 'Example', kind: 'character' }, { id: 'example', now: '2026-01-01T00:00:00.000Z' });
    expect(Object.keys(record).sort()).toEqual([
      'chromaKey', 'createdAt', 'deleted', 'deletedAt', 'id', 'imageMode', 'imageModelId', 'importedFrom',
      'kind', 'name', 'notes', 'publishBinding', 'spec', 'status', 'updatedAt',
    ]);
  });
});
