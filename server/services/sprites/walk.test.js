/**
 * Walk-animation workflow orchestration (#2897): generation gating on locked
 * anchors, run-record lifecycle through the video completion hook, approval
 * with tamper checks, walk-set finalization + immutability, and the loop
 * trimmer. The queue and the deterministic postprocess are mocked — the
 * postprocess itself is covered by walkPostprocess.test.js.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { createHash } from 'crypto';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-walk-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, {
    data: TEST_ROOT,
    sprites: join(TEST_ROOT, 'sprites'),
    images: join(TEST_ROOT, 'images'),
    videos: join(TEST_ROOT, 'videos'),
  });
  return actual;
});

const enqueueJob = vi.fn(() => ({ jobId: 'vid-job-1234567890', position: 0, status: 'queued' }));
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: (...args) => enqueueJob(...args),
  mediaJobEvents: { on: () => {}, off: () => {} },
}));

vi.mock('../imageGen/index.js', () => ({
  resolveImageCleaners: () => ({ cleanC2PA: false, denoise: false }),
}));

vi.mock('../settings.js', () => ({
  getSettings: async () => ({
    imageGen: { mode: 'grok', grok: { enabled: true, grokPath: '/usr/local/bin/grok' } },
  }),
}));

// Keep the videoGen graph out of this mocked suite — only the duration
// contract is consumed.
vi.mock('../videoGen/grok.js', () => ({ GROK_VIDEO_DURATIONS: [6, 10] }));

const prepareWalkAnchorInput = vi.fn(async (_anchorAbs, destAbs) => {
  await mkdir(join(destAbs, '..'), { recursive: true });
  await writeFile(destAbs, 'stub-transparent-anchor');
  return { preparation: 'measured-key-alpha-recovery-plus-despill' };
});
const runWalkPostprocess = vi.fn(async ({ runRel }) => ({
  manifestPath: `${runRel}/generated/manifest.json`,
  stripPreview: { stripPath: `${runRel}/generated/strip.png`, frameCount: 8, fps: 12, cellWidth: 384, cellHeight: 384, row: 0, startColumn: 0 },
}));
vi.mock('./walkPostprocess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    prepareWalkAnchorInput: (...args) => prepareWalkAnchorInput(...args),
    runWalkPostprocess: (...args) => runWalkPostprocess(...args),
  };
});

const records = await import('./records.js');
const { listSpriteAssets } = await import('./paths.js');
const { lockReference } = await import('./reference.js');
const {
  getWalkState, startWalkGeneration, attachWalkVideo, approveWalkDirection, rerunWalkPostprocess,
} = await import('./walk.js');
const { SPRITE_DIRECTIONS, ANCHOR_DIRECTIONS } = await import('./prompts.js');

let seq = 0;
const newId = () => `walker-${++seq}`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function writeCandidatePng(path) {
  const w = 64; const h = 64;
  const buf = Buffer.alloc(w * h * 3);
  for (let p = 0; p < w * h; p++) buf.set([255, 0, 255], p * 3);
  for (let y = 10; y < 40; y++) for (let x = 20; x < 30; x++) buf.set([23, 107, 101], (y * w + x) * 3);
  await mkdir(join(path, '..'), { recursive: true });
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path);
}

async function placeCandidate(recordId, target, name) {
  const candDir = join(TEST_ROOT, 'sprites', recordId, 'reference', 'candidates');
  await writeCandidatePng(join(candDir, name));
  await writeFile(join(candDir, `${name.replace(/\.png$/, '')}.generation.json`), JSON.stringify({
    schemaVersion: 1, target, chromaKey: '#FF00FF',
  }));
  return `reference/candidates/${name}`;
}

async function characterWithLockedAnchors(id, directions = ['east']) {
  await records.createRecord({ kind: 'character', name: 'Walker' }, id);
  await lockReference(id, { target: 'main', candidate: await placeCandidate(id, 'main', 'walk-south-candidate-01.png') });
  for (const dir of directions.filter((d) => d !== 'south')) {
    await lockReference(id, { target: dir, candidate: await placeCandidate(id, dir, `walk-${dir}-candidate-01.png`) });
  }
  return id;
}

async function makeCandidateRun(recordId, direction, { stripBytes = `strip-${direction}` } = {}) {
  const runId = `walk-${direction}-${(seq++).toString(16).padStart(8, '0')}`;
  const runDir = join(TEST_ROOT, 'sprites', recordId, 'grok', runId, 'generated');
  await mkdir(runDir, { recursive: true });
  const stripName = `${recordId}-walk-${direction}-strip.png`;
  await writeFile(join(runDir, stripName), stripBytes);
  const packaged = {
    schemaVersion: 1,
    kind: 'deterministically-packaged-grok-walk-video',
    characterId: recordId,
    direction,
    frameRate: 12,
    frameCount: 8,
    stripPath: `grok/${runId}/generated/${stripName}`,
    stripSha256: sha256(Buffer.from(stripBytes)),
  };
  const manifestRel = `grok/${runId}/generated/${recordId}-walk-${direction}-manifest.json`;
  await writeFile(join(runDir, `${recordId}-walk-${direction}-manifest.json`), JSON.stringify(packaged));
  await writeFile(join(TEST_ROOT, 'sprites', recordId, 'grok', runId, 'animation-run.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'grok-game-animation-frames-run',
    status: 'candidate',
    id: runId,
    characterId: recordId,
    direction,
    chromaKey: '#FF00FF',
    createdAt: new Date().toISOString(),
    postprocessManifest: manifestRel,
  }));
  return { runId, manifestRel };
}

beforeEach(() => {
  enqueueJob.mockClear();
  prepareWalkAnchorInput.mockClear();
  runWalkPostprocess.mockClear();
  rmSync(join(TEST_ROOT, 'sprite-records.json'), { force: true });
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('startWalkGeneration', () => {
  it('409s when the direction anchor is not locked', async () => {
    const id = newId();
    await records.createRecord({ kind: 'character', name: 'Walker' }, id);
    await expect(startWalkGeneration(id, { direction: 'east' }))
      .rejects.toMatchObject({ code: 'ANCHOR_NOT_LOCKED' });
  });

  it('queues a grok i2v job with the spriteWalk tag off a locked anchor', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const result = await startWalkGeneration(id, { direction: 'east' });
    expect(result.jobId).toBe('vid-job-1234567890');
    expect(result.runId).toMatch(/^walk-east-[0-9a-f]{8}$/);
    expect(result.duration).toBe(6);

    const call = enqueueJob.mock.calls[0][0];
    expect(call.kind).toBe('video');
    expect(call.owner).toBe('sprites');
    expect(call.params.mode).toBe('grok');
    expect(call.params.videoMode).toBe('image');
    expect(call.params.grokPath).toBe('/usr/local/bin/grok');
    expect(call.params.sourceImagePath).toBe(
      join(TEST_ROOT, 'sprites', id, 'grok', result.runId, 'generated', 'input-anchor-transparent.png'),
    );
    expect(call.params.prompt).toContain('walking east');
    expect(call.params.prompt).toContain('magenta (#FF00FF)');
    expect(call.params.spriteWalk).toEqual({ recordId: id, direction: 'east', runId: result.runId, chromaKey: '#FF00FF' });

    // Transparent input was prepared from the locked anchor, and the run
    // record persisted with the queue job id.
    expect(prepareWalkAnchorInput).toHaveBeenCalledOnce();
    const { runs } = await getWalkState(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: result.runId, status: 'queued', jobId: 'vid-job-1234567890', direction: 'east', chromaKey: '#FF00FF',
    });
    expect(runs[0].animationInputPreparation).toBe('measured-key-alpha-recovery-plus-despill');
  });

  it('animates south straight off the frozen main and honors duration 10', async () => {
    const id = await characterWithLockedAnchors(newId(), []);
    const result = await startWalkGeneration(id, { direction: 'south', duration: 10 });
    expect(result.duration).toBe(10);
    expect(enqueueJob.mock.calls[0][0].params.duration).toBe(10);
  });
});

describe('attachWalkVideo (completion hook)', () => {
  async function queuedRun(id) {
    const { runId } = await startWalkGeneration(id, { direction: 'east' });
    await mkdir(join(TEST_ROOT, 'videos'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'videos', 'vid-job-1234567890.mp4'), 'fake-mp4-bytes');
    return runId;
  }

  it('copies the video into the run and records the packaged candidate', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const runId = await queuedRun(id);
    const result = await attachWalkVideo({
      recordId: id, direction: 'east', runId, filename: 'vid-job-1234567890.mp4', jobId: 'vid-job-1234567890',
    });
    expect(result).toEqual({ runId, status: 'candidate' });
    expect(runWalkPostprocess).toHaveBeenCalledOnce();
    const ppArgs = runWalkPostprocess.mock.calls[0][0];
    expect(ppArgs).toMatchObject({ recordId: id, direction: 'east', chromaKey: '#FF00FF', runRel: `grok/${runId}` });
    const video = await readFile(join(TEST_ROOT, 'sprites', id, 'grok', runId, 'generated', 'source-video.mp4'), 'utf8');
    expect(video).toBe('fake-mp4-bytes');
    const { runs } = await getWalkState(id);
    expect(runs[0]).toMatchObject({
      status: 'candidate',
      postprocessManifest: `grok/${runId}/generated/manifest.json`,
    });
    expect(runs[0].stripPreview.frameCount).toBe(8);
    expect(runs[0].sourceVideoSha256).toBe(sha256(Buffer.from('fake-mp4-bytes')));
  });

  it('captures a postprocess failure on the run record instead of throwing', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const runId = await queuedRun(id);
    runWalkPostprocess.mockRejectedValueOnce(new Error('no detectable moving walk cycle'));
    const result = await attachWalkVideo({
      recordId: id, direction: 'east', runId, filename: 'vid-job-1234567890.mp4',
    });
    expect(result.status).toBe('error');
    const { runs } = await getWalkState(id);
    expect(runs[0].status).toBe('error');
    expect(runs[0].postprocessError).toMatch(/walk cycle/);
  });

  it('refuses to attach onto an approved run (Render Queue retry can re-fire the tag)', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const { runId } = await makeCandidateRun(id, 'east');
    await approveWalkDirection(id, { direction: 'east', runId });
    await mkdir(join(TEST_ROOT, 'videos'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'videos', 'retry-clip.mp4'), 'retried');
    runWalkPostprocess.mockClear();
    expect(await attachWalkVideo({ recordId: id, direction: 'east', runId, filename: 'retry-clip.mp4' })).toBeNull();
    expect(runWalkPostprocess).not.toHaveBeenCalled();
    // The frozen artifacts were not touched.
    const { runs } = await getWalkState(id);
    expect(runs.find((r) => r.id === runId).status).toBe('candidate');
  });

  it('refuses to attach after the walk set is finalized', async () => {
    const id = await characterWithLockedAnchors(newId(), ANCHOR_DIRECTIONS);
    for (const direction of SPRITE_DIRECTIONS) {
      const { runId } = await makeCandidateRun(id, direction);
      await approveWalkDirection(id, { direction, runId });
    }
    // A stale queued run whose clip lands after finalization must not attach.
    const staleRunId = 'walk-east-0badc0de';
    await mkdir(join(TEST_ROOT, 'sprites', id, 'grok', staleRunId), { recursive: true });
    await writeFile(join(TEST_ROOT, 'sprites', id, 'grok', staleRunId, 'animation-run.json'), JSON.stringify({
      schemaVersion: 1, id: staleRunId, status: 'queued', characterId: id, direction: 'east', chromaKey: '#FF00FF',
    }));
    await mkdir(join(TEST_ROOT, 'videos'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'videos', 'late-clip.mp4'), 'late');
    runWalkPostprocess.mockClear();
    expect(await attachWalkVideo({ recordId: id, direction: 'east', runId: staleRunId, filename: 'late-clip.mp4' })).toBeNull();
    expect(runWalkPostprocess).not.toHaveBeenCalled();
  });

  it('skips silently when the run record or video is missing', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    expect(await attachWalkVideo({ recordId: id, direction: 'east', runId: 'walk-east-deadbeef', filename: 'x.mp4' })).toBeNull();
    const runId = await queuedRun(id);
    expect(await attachWalkVideo({ recordId: id, direction: 'east', runId, filename: 'not-there.mp4' })).toBeNull();
  });
});

describe('rerunWalkPostprocess', () => {
  it('404s an unknown run and 409s a run with no video', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    await expect(rerunWalkPostprocess(id, { runId: 'walk-east-deadbeef' }))
      .rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    const { runId } = await startWalkGeneration(id, { direction: 'east' });
    await expect(rerunWalkPostprocess(id, { runId }))
      .rejects.toMatchObject({ code: 'VIDEO_NOT_READY' });
  });

  it('re-packages a landed video and 409s an approved run', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const { runId } = await startWalkGeneration(id, { direction: 'east' });
    const videoAbs = join(TEST_ROOT, 'sprites', id, 'grok', runId, 'generated', 'source-video.mp4');
    await writeFile(videoAbs, 'landed');
    const run = await rerunWalkPostprocess(id, { runId });
    expect(run.status).toBe('candidate');

    // Approve it (needs a packaged manifest + strip on disk), then rerun 409s.
    const { runId: approvedRun } = await makeCandidateRun(id, 'east');
    await writeFile(join(TEST_ROOT, 'sprites', id, 'grok', approvedRun, 'generated', 'source-video.mp4'), 'landed');
    await approveWalkDirection(id, { direction: 'east', runId: approvedRun });
    await expect(rerunWalkPostprocess(id, { runId: approvedRun }))
      .rejects.toMatchObject({ code: 'RUN_APPROVED' });
  });
});

describe('approveWalkDirection', () => {
  it('validates run existence, direction, and candidate status', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    await expect(approveWalkDirection(id, { direction: 'east', runId: 'walk-east-deadbeef' }))
      .rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    const { runId } = await makeCandidateRun(id, 'east');
    await expect(approveWalkDirection(id, { direction: 'west', runId }))
      .rejects.toMatchObject({ code: 'RUN_DIRECTION_MISMATCH' });
    const { runId: queuedId } = await startWalkGeneration(id, { direction: 'east' });
    await expect(approveWalkDirection(id, { direction: 'east', runId: queuedId }))
      .rejects.toMatchObject({ code: 'RUN_NOT_CANDIDATE' });
  });

  it('rejects a strip modified after packaging', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const { runId } = await makeCandidateRun(id, 'east');
    await writeFile(
      join(TEST_ROOT, 'sprites', id, 'grok', runId, 'generated', `${id}-walk-east-strip.png`),
      'tampered',
    );
    await expect(approveWalkDirection(id, { direction: 'east', runId }))
      .rejects.toMatchObject({ code: 'RUN_STRIP_INVALID' });
  });

  it('records the approval in the selection', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const { runId, manifestRel } = await makeCandidateRun(id, 'east');
    const state = await approveWalkDirection(id, { direction: 'east', runId });
    expect(state.selection.kind).toBe('reviewed-directional-walk-selection');
    expect(state.selection.status).toBe('in-progress');
    expect(state.selection.directions.east).toMatchObject({
      status: 'approved', runId, runPath: `grok/${runId}`, runManifest: manifestRel,
    });
    expect(state.selection.directions.east.runManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(state.walkSet).toBeNull();
  });

  it('finalizes the walk set on the 8th approval and freezes the record', async () => {
    const id = await characterWithLockedAnchors(newId(), ANCHOR_DIRECTIONS);
    let state;
    for (const direction of SPRITE_DIRECTIONS) {
      const { runId } = await makeCandidateRun(id, direction);
      state = await approveWalkDirection(id, { direction, runId });
    }
    expect(state.selection.status).toBe('complete');
    expect(state.walkSet).toMatchObject({
      kind: 'finalized-eight-direction-walk-set',
      status: 'final',
      characterId: id,
      directionOrder: SPRITE_DIRECTIONS,
    });
    expect(Object.keys(state.walkSet.directions)).toHaveLength(8);
    expect((await records.getRecord(id)).status).toBe('walk-complete');

    // The finalized set is immutable: no new generation, approval, or rerun.
    await expect(startWalkGeneration(id, { direction: 'east' }))
      .rejects.toMatchObject({ code: 'WALK_SET_FINAL' });
    const eastRun = state.walkSet.directions.east.runId;
    await expect(approveWalkDirection(id, { direction: 'east', runId: eastRun }))
      .rejects.toMatchObject({ code: 'WALK_SET_FINAL' });
    await expect(rerunWalkPostprocess(id, { runId: eastRun }))
      .rejects.toMatchObject({ code: 'WALK_SET_FINAL' });
  });
});

describe('listSpriteAssets run-intermediate exclusion', () => {
  it('omits raw extraction frames but keeps packaged frames and the review sheet', async () => {
    const id = await characterWithLockedAnchors(newId(), []);
    const gen = join(TEST_ROOT, 'sprites', id, 'grok', 'walk-east-00c0ffee', 'generated');
    await mkdir(join(gen, 'raw'), { recursive: true });
    await mkdir(join(gen, 'frames'), { recursive: true });
    await mkdir(join(gen, 'review'), { recursive: true });
    await writeFile(join(gen, 'raw', 'source-0001.png'), 'raw');
    await writeFile(join(gen, 'frames', '00-left-contact.png'), 'frame');
    await writeFile(join(gen, 'review', 'contrast.png'), 'sheet');
    const paths = (await listSpriteAssets(id)).map((a) => a.path);
    expect(paths).not.toContain('grok/walk-east-00c0ffee/generated/raw/source-0001.png');
    expect(paths).toContain('grok/walk-east-00c0ffee/generated/frames/00-left-contact.png');
    expect(paths).toContain('grok/walk-east-00c0ffee/generated/review/contrast.png');
  });
});

describe('getWalkState', () => {
  it('returns empty state for a fresh character and newest-first runs', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east', 'west']);
    expect(await getWalkState(id)).toEqual({ runs: [], selection: null, walkSet: null });
    await startWalkGeneration(id, { direction: 'east' });
    await new Promise((r) => { setTimeout(r, 5); });
    const second = await startWalkGeneration(id, { direction: 'west' });
    const { runs } = await getWalkState(id);
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe(second.runId);
  });
});
