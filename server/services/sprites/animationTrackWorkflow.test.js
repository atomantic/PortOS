/**
 * The generic per-track animation workflow (#3136).
 *
 * Replaces `scanner.test.js` + `ambient.test.js`, which asserted the same six
 * behaviors twice against two copies of one control flow. Here every behavior is
 * asserted ONCE, table-driven across both shipped non-walk tracks — which is the
 * property that actually matters now: the module must read the track's registry
 * row rather than branch on its id. A per-track copy of these assertions could
 * pass while the module secretly `if (track === 'ambient')`d its way through.
 *
 * The two rows differ in exactly the ways the registry says they do — a
 * directional track seeded per-facing from its locked anchor vs. a
 * non-directional one seeded from the one locked main — so running one table over
 * both is also the regression test for the fields #3136 introduced.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { lockAllAnchors, placeCandidate, expectCarriesCorrection } from './spriteTestFixtures.js';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-track-workflow-test-'));

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

const executeTuiRun = vi.fn(() => new Promise(() => {}));
vi.mock('../tuiPromptRunner.js', () => ({
  executeTuiRun: (...args) => executeTuiRun(...args),
}));

vi.mock('../settings.js', () => ({
  getSettings: async () => ({ imageGen: { grok: { grokPath: '/usr/local/bin/grok' } } }),
}));

// Reports a fixed PORTRAIT anchor size so the local lane's REAL canvas chooser
// is exercised — only the sharp measurement is stubbed.
const STUB_ANCHOR_SIZE = { width: 512, height: 896 };
const prepareWalkAnchorChromaInput = vi.fn(async (_sourceAbs, inputAbs, _chromaKey, chooseCanvas = null) => {
  await mkdir(join(inputAbs, '..'), { recursive: true });
  const bytes = Buffer.from('track-chroma-input');
  await writeFile(inputAbs, bytes);
  return {
    preparation: 'composited-over-solid-chroma-matte',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    canvas: chooseCanvas ? chooseCanvas(STUB_ANCHOR_SIZE) : null,
  };
});
vi.mock('./walkPostprocess.js', async (importOriginal) => ({
  ...await importOriginal(),
  prepareWalkAnchorChromaInput: (...args) => prepareWalkAnchorChromaInput(...args),
}));

// ── Local render lane (#4876) ───────────────────────────────────────────────
// Only the ENVIRONMENT is stubbed (model catalog, runtime/weight probes, job
// queue) so the real lane logic runs through the workflow — see the same note in
// walk.test.js. The point of running the table over BOTH tracks is that the
// provider is registry-agnostic: a directional and a non-directional row must
// dispatch identically, with no `if (track === …)` anywhere in the lane.
const H3_MODEL = {
  id: 'minimax_h3_8bit',
  name: 'MiniMax H3 MLX 8-bit',
  repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
  revision: 'rev-abc',
  runtime: 'minimax_h3',
  defaultFrames: 124,
  frameOptions: [107, 124, 141, 158, 175],
  fpsOptions: [24],
  defaultWidth: 1344,
  defaultHeight: 768,
  resolutionOptions: [{ w: 1344, h: 768 }, { w: 768, h: 768 }, { w: 768, h: 1024 }],
};
let localRuntimeReady = true;
vi.mock('../../lib/mediaModels.js', async (importOriginal) => ({
  ...await importOriginal(),
  getVideoModels: () => [H3_MODEL],
}));
vi.mock('../videoGen/runtimes.js', async (importOriginal) => ({
  ...await importOriginal(),
  BYOV_RUNTIME_INFO: { minimax_h3: { label: 'MiniMax H3 MLX' } },
  isByovRuntimeReady: async () => localRuntimeReady,
}));
vi.mock('../../lib/hfCache.js', async (importOriginal) => ({
  ...await importOriginal(),
  inspectModelCache: async () => ({ cached: true, sizeBytes: 1, snapshotPath: '/snap' }),
  findCachedRepoFiles: async () => ['/snap/a.safetensors'],
}));
const enqueuedVideoJobs = [];
// Job states are controllable so the staleness tests can state the queue answer
// they are about; an enqueue defaults its job to running.
const queuedJobsById = new Map();
vi.mock('../mediaJobQueue/index.js', async (importOriginal) => ({
  ...await importOriginal(),
  enqueueJob: (job) => {
    const id = `mjob-${enqueuedVideoJobs.length + 1}`;
    enqueuedVideoJobs.push({ id, ...job });
    queuedJobsById.set(id, { id, status: 'running' });
    return { jobId: id, position: 1, status: 'queued' };
  },
  getJob: (id) => queuedJobsById.get(id) || null,
}));

const records = await import('./records.js');
const { lockReference } = await import('./reference.js');
const {
  getTrackState, startTrackGeneration, approveTrackRun, trackAuthoringDirections, trackSetRelPath,
  recordsCarryingTrack, reopenTrackDirection,
} = await import('./animationTrackWorkflow.js');
const {
  getAnimationTrack, sourceReferenceFor, SCANNER_TRACK, AMBIENT_TRACK,
} = await import('./animationTracks.js');
// #3152 — `scanner`/`ambient` are seeded STORE rows now, so the expectations below
// resolve them through the merged table exactly as the module under test does.
// This suite deliberately reads the SHIPPED seed rather than writing a synthetic
// store: its subject is "the generic workflow reads the row it was handed", and the
// two seeded rows are precisely the directional/non-directional pair that proves it.
const { getEffectiveAnimationTracks } = await import('./animationTrackStore.js');
const EFFECTIVE = getEffectiveAnimationTracks();

let sequence = 0;
const newId = () => `track-${++sequence}`;

// One fixture per SOURCE-REFERENCE shape, not per track: a directional track
// needs a locked anchor for the facing it animates, a non-directional one needs
// the record's single locked main. That is the registry difference under test.
async function characterWithEastAnchor(id) {
  await records.createRecord({ kind: 'character', name: 'Placeholder Hero' }, id);
  await lockAllAnchors(TEST_ROOT, id, { lockReference, directions: ['east'], records });
  return id;
}

async function placeWithLockedMain(id) {
  await records.createRecord({ kind: 'place', name: 'Example Willow' }, id);
  const candidate = await placeCandidate(TEST_ROOT, id, 'main', 'main-candidate-01.png');
  await lockReference(id, { target: 'main', candidate });
  return id;
}

// The table every behavior below runs over. `direction` is the facing the
// generate call names (absent for a non-directional track, which derives row 0
// itself) and `promptMarker` is a phrase only THAT track's prompt contains — so a
// module that sent the wrong track's prompt fails here rather than at render time.
const TRACKS = [
  {
    id: SCANNER_TRACK,
    seed: characterWithEastAnchor,
    body: { direction: 'east' },
    expectedDirection: 'east',
    runIdPattern: /^scanner-east-[0-9a-f]{8}$/,
    promptMarker: 'scanner action',
    correction: 'the sweep never returns to the start pose',
    inputName: 'input-anchor-chroma.png',
  },
  {
    id: AMBIENT_TRACK,
    seed: placeWithLockedMain,
    body: {},
    expectedDirection: 'south',
    runIdPattern: /^ambient-[0-9a-f]{8}$/,
    promptMarker: 'ambient loop',
    correction: 'the branches barely move',
    inputName: 'input-main-chroma.png',
  },
];

beforeEach(() => {
  executeTuiRun.mockClear();
  executeTuiRun.mockImplementation(() => new Promise(() => {}));
  prepareWalkAnchorChromaInput.mockClear();
  rmSync(join(TEST_ROOT, 'sprite-records.json'), { force: true });
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe.each(TRACKS)('the generic workflow drives the $id track', (track) => {
  const row = () => getAnimationTrack(track.id, EFFECTIVE);

  it('is provider-silent on reads, then starts one user-triggered render at the row\'s defaults', async () => {
    const id = await track.seed(newId());

    // The AI-provider policy: reading state must never reach a provider.
    const initial = await getTrackState(track.id, id);
    expect(initial).toMatchObject({
      track: track.id,
      // The row itself rides along so the client renders label/bounds/facing
      // count from data rather than mirroring them.
      definition: {
        minFrameCount: row().minFrameCount,
        maxFrameCount: row().maxFrameCount,
        defaultFrameCount: row().defaultFrameCount,
        defaultFps: row().defaultFps,
      },
      selection: null,
      set: null,
      runs: [],
    });
    expect(executeTuiRun).not.toHaveBeenCalled();

    const result = await startTrackGeneration(track.id, id, track.body);
    expect(result).toMatchObject({ duration: 6 });
    expect(result.runId).toMatch(track.runIdPattern);
    expect(result.shellSession).toBe(result.runId);
    expect(executeTuiRun).toHaveBeenCalledOnce();
    const call = executeTuiRun.mock.calls[0][0];
    expect(call).toMatchObject({
      runId: result.runId,
      workspacePath: join(TEST_ROOT, 'sprites', id, 'runs', result.runId, 'generated'),
    });
    // This track's OWN prompt, not a fallback to walk's.
    expect(call.prompt).toContain(track.promptMarker);
    expect(call.prompt).toContain('image_to_video');

    // Defaults come from the row — the whole point of the parameterization.
    expect((await getTrackState(track.id, id)).runs).toMatchObject([{
      id: result.runId,
      track: track.id,
      status: 'rendering',
      frameCount: row().defaultFrameCount,
      fps: row().defaultFps,
      direction: track.expectedDirection,
    }]);
  });

  it('seeds the render from the reference its row names', async () => {
    const id = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, id, track.body);
    // A directional track prepares its facing's anchor; a non-directional one the
    // single main. Distinguishable by the prepared input's filename, which is
    // also what the run record stamps as provenance.
    const [, inputAbs] = prepareWalkAnchorChromaInput.mock.calls[0];
    expect(inputAbs.endsWith(track.inputName), `${track.id} prepares ${track.inputName}`).toBe(true);
    const { runs } = await getTrackState(track.id, id);
    const run = runs.find((r) => r.id === runId);
    expect(run.animationInputPath).toBe(`runs/${runId}/generated/${track.inputName}`);
    // `anchorPath` names whichever reference seeded it, and is what the approve
    // gate's staleness check re-hashes.
    expect(run.anchorPath).toBeTruthy();
    expect(run.anchorSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('clamps a requested frame count and fps into the row\'s range', async () => {
    const id = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, id, {
      ...track.body, frameCount: 999, fps: 999,
    });
    const { runs } = await getTrackState(track.id, id);
    expect(runs.find((r) => r.id === runId)).toMatchObject({
      frameCount: row().maxFrameCount,
      fps: row().maxFps,
    });
  });

  it('appends a trimmed correction note to the prompt and stamps it on the run (#3134)', async () => {
    const id = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, id, {
      ...track.body, correctionPrompt: `  ${track.correction}  `,
    });
    expectCarriesCorrection(expect, executeTuiRun.mock.calls[0][0].prompt, track.correction);
    const { runs } = await getTrackState(track.id, id);
    expect(runs.find((r) => r.id === runId).correctionPrompt).toBe(track.correction);
  });

  it('leaves a blank correction note out of the prompt and the run record (#3134)', async () => {
    // The task is `<track prompt>\n\n<per-run paths>` — compare the prompt only.
    const trackPrompt = () => executeTuiRun.mock.calls[0][0].prompt.split('\n\n')[0];
    const plain = await track.seed(newId());
    await startTrackGeneration(track.id, plain, track.body);
    const blindPrompt = trackPrompt();
    executeTuiRun.mockClear();

    const blank = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, blank, { ...track.body, correctionPrompt: ' \n ' });
    expect(trackPrompt()).toBe(blindPrompt);
    const { runs } = await getTrackState(track.id, blank);
    expect(runs.find((r) => r.id === runId)).not.toHaveProperty('correctionPrompt');
  });

  it('refuses a second in-flight render for the same target', async () => {
    const id = await track.seed(newId());
    await startTrackGeneration(track.id, id, track.body);
    await expect(startTrackGeneration(track.id, id, track.body))
      .rejects.toMatchObject({ status: 409, code: 'TRACK_RENDER_IN_PROGRESS' });
  });

  it('refuses to generate before the source reference is locked', async () => {
    // A record with NO locked reference at all: the 409 must name the artifact
    // this row asked for, and its code must distinguish the two shapes.
    const id = newId();
    await records.createRecord(
      { kind: row().kinds[0] === 'character' ? 'character' : 'place', name: 'Unlocked' },
      id,
    );
    await expect(startTrackGeneration(track.id, id, track.body)).rejects.toMatchObject({
      status: 409,
      code: sourceReferenceFor(track.id, EFFECTIVE) === 'main' ? 'MAIN_NOT_LOCKED' : 'ANCHOR_NOT_LOCKED',
    });
    expect(executeTuiRun).not.toHaveBeenCalled();
  });

  it('refuses to approve a run that was never packaged', async () => {
    const id = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, id, track.body);
    await expect(approveTrackRun(track.id, id, { ...track.body, runId }))
      .rejects.toMatchObject({ status: 409, code: 'RUN_NOT_CANDIDATE' });
  });

  it('refuses to approve an unknown run id', async () => {
    const id = await track.seed(newId());
    await expect(approveTrackRun(track.id, id, { ...track.body, runId: 'no-such-run' }))
      .rejects.toMatchObject({ status: 404, code: 'RUN_NOT_FOUND' });
  });

  it('resolves the facing against the TRACK\'s own list, not the grid\'s', async () => {
    const id = await track.seed(newId());
    if (row().directional) {
      // The route's Zod enum accepts all eight grid facings, but a track is
      // authored across its OWN slice — so a facing outside it must be refused
      // here rather than authoring a set the compiler will later refuse, after
      // the render was already paid for.
      await expect(startTrackGeneration(track.id, id, { ...track.body, direction: 'nowhere' }))
        .rejects.toMatchObject({ status: 400, code: 'TRACK_DIRECTION_INVALID' });
      await expect(startTrackGeneration(track.id, id, { ...track.body, direction: undefined }))
        .rejects.toMatchObject({ status: 400, code: 'TRACK_DIRECTION_INVALID' });
      expect(executeTuiRun).not.toHaveBeenCalled();
    } else {
      // A single-row track derives its facing, so a bogus request value is
      // ignored rather than trusted — it can't drift from what the compiler
      // will expect.
      const { runId } = await startTrackGeneration(track.id, id, { ...track.body, direction: 'nowhere' });
      const { runs } = await getTrackState(track.id, id);
      expect(runs.find((r) => r.id === runId).direction).toBe(track.expectedDirection);
    }
  });
});

describe('local render lane (#4876)', () => {
  beforeEach(() => {
    localRuntimeReady = true;
    enqueuedVideoJobs.length = 0;
    queuedJobsById.clear();
  });

  it.each(TRACKS)('$id defaults to the grok TUI when no provider is named', async (track) => {
    const id = await track.seed(newId());
    const res = await startTrackGeneration(track.id, id, track.body);
    expect(res.provider).toBe('grok');
    expect(res.shellSession).toBe(res.runId);
    expect(executeTuiRun).toHaveBeenCalledTimes(1);
    expect(enqueuedVideoJobs).toHaveLength(0);
  });

  it.each(TRACKS)('$id queues a local media job instead, carrying its OWN prompt', async (track) => {
    const id = await track.seed(newId());
    const res = await startTrackGeneration(track.id, id, { ...track.body, provider: 'local' });
    expect(executeTuiRun).not.toHaveBeenCalled();
    expect(res.provider).toBe('local');
    expect(res.jobId).toBe('mjob-1');
    expect(res.shellSession).toBeUndefined();
    expect(enqueuedVideoJobs).toHaveLength(1);
    expect(enqueuedVideoJobs[0]).toMatchObject({ kind: 'video' });
    expect(enqueuedVideoJobs[0].params).toMatchObject({
      modelId: 'minimax_h3_8bit', mode: 'image', fps: 24, hidden: true,
    });
    // The track's own prompt, not the walk's or the sibling track's.
    expect(enqueuedVideoJobs[0].params.prompt).toContain(track.promptMarker);
    // Portrait anchor → portrait canvas, so videoGen's center-crop is a no-op.
    expect(enqueuedVideoJobs[0].params).toMatchObject({ width: 768, height: 1024 });
  });

  it.each(TRACKS)('$id stamps the lane provenance on its run record', async (track) => {
    const id = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, id, { ...track.body, provider: 'local' });
    const run = (await getTrackState(track.id, id)).runs.find((r) => r.id === runId);
    expect(run).toMatchObject({
      provider: 'minimax-h3-local',
      videoModelId: 'minimax_h3_8bit',
      videoRuntime: 'minimax_h3',
      renderFps: 24,
      jobId: 'mjob-1',
      track: track.id,
      status: 'rendering',
    });
    expect(run.shellSession).toBeNull();
    // The track's own registry-derived packing knobs are untouched by the render.
    expect(run.frameCount).toBe(EFFECTIVE[track.id].defaultFrameCount);
    expect(run.fps).toBe(EFFECTIVE[track.id].defaultFps);
  });

  it.each(TRACKS)('$id 409s without creating a run directory when the runtime is missing', async (track) => {
    const id = await track.seed(newId());
    localRuntimeReady = false;
    await expect(startTrackGeneration(track.id, id, { ...track.body, provider: 'local' }))
      .rejects.toMatchObject({ status: 409, code: 'LOCAL_VIDEO_PROVIDER_NOT_READY' });
    expect((await getTrackState(track.id, id)).runs).toEqual([]);
    expect(enqueuedVideoJobs).toHaveLength(0);
  });

  it.each(TRACKS)('$id refuses an unknown provider rather than falling back to the paid lane', async (track) => {
    const id = await track.seed(newId());
    await expect(startTrackGeneration(track.id, id, { ...track.body, provider: 'minimax' }))
      .rejects.toMatchObject({ status: 400, code: 'ANIMATION_PROVIDER_INVALID' });
    expect(executeTuiRun).not.toHaveBeenCalled();
    expect(enqueuedVideoJobs).toHaveLength(0);
  });
});

// A track run stuck at `rendering` used to be UNRECOVERABLE: the in-flight guard
// 409s every regenerate for that facing, there is no per-run delete, and
// `reopenTrackDirection` only touches APPROVED runs. The walk lane always had a
// read-time backstop for this; the track lane never did, and the local lane's
// multi-hour renders (whose only resolver is a completion hook that a pruned
// archive or a throwing attach can miss) made the gap materially reachable.
describe('stranded-run normalization (#4876)', () => {
  const runRecordPath = (recordId, runId) => join(
    TEST_ROOT, 'sprites', recordId, 'runs', runId, 'animation-run.json',
  );
  const backdateRun = async (recordId, runId, ms) => {
    const stored = JSON.parse(await readFile(runRecordPath(recordId, runId), 'utf8'));
    stored.createdAt = new Date(Date.now() - ms).toISOString();
    await writeFile(runRecordPath(recordId, runId), JSON.stringify(stored));
  };

  beforeEach(() => {
    localRuntimeReady = true;
    enqueuedVideoJobs.length = 0;
    queuedJobsById.clear();
  });

  it.each(TRACKS)('$id: a grok run past the TUI cap reads as an error and unblocks regenerate', async (track) => {
    const id = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, id, track.body);
    await backdateRun(id, runId, 31 * 60_000 + 60_000);
    const run = (await getTrackState(track.id, id)).runs.find((r) => r.id === runId);
    expect(run.status).toBe('error');
    expect(run.postprocessError).toMatch(/interrupted/);
    // The point of the normalization: the facing becomes renderable again.
    await expect(startTrackGeneration(track.id, id, track.body)).resolves.toBeTruthy();
  });

  it.each(TRACKS)('$id: a grok run inside the cap is left alone', async (track) => {
    const id = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, id, track.body);
    await backdateRun(id, runId, 5 * 60_000);
    const run = (await getTrackState(track.id, id)).runs.find((r) => r.id === runId);
    expect(run.status).toBe('rendering');
  });

  it.each(TRACKS)('$id: a LOCAL run stays live for hours while its job runs', async (track) => {
    const id = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, id, { ...track.body, provider: 'local' });
    await backdateRun(id, runId, 5 * 60 * 60_000);
    const run = (await getTrackState(track.id, id)).runs.find((r) => r.id === runId);
    expect(run.status).toBe('rendering');
  });

  it.each(TRACKS)('$id: a LOCAL run whose job died reads as an error immediately', async (track) => {
    const id = await track.seed(newId());
    const { runId, jobId } = await startTrackGeneration(track.id, id, { ...track.body, provider: 'local' });
    queuedJobsById.set(jobId, { id: jobId, status: 'failed', error: 'interrupted by restart' });
    const run = (await getTrackState(track.id, id)).runs.find((r) => r.id === runId);
    expect(run.status).toBe('error');
  });

  it.each(TRACKS)('$id: a LOCAL run whose job COMPLETED is settling, not dead', async (track) => {
    // The attach is copying and hashing the clip. Calling that dead would report
    // a successful render as interrupted and unblock a duplicate render.
    const id = await track.seed(newId());
    const { runId, jobId } = await startTrackGeneration(track.id, id, { ...track.body, provider: 'local' });
    queuedJobsById.set(jobId, { id: jobId, status: 'completed' });
    const run = (await getTrackState(track.id, id)).runs.find((r) => r.id === runId);
    expect(run.status).toBe('rendering');
  });

  it.each(TRACKS)('$id: a LOCAL run the queue has forgotten falls back to a DAY, not the grok cap', async (track) => {
    const id = await track.seed(newId());
    const { runId, jobId } = await startTrackGeneration(track.id, id, { ...track.body, provider: 'local' });
    queuedJobsById.delete(jobId);
    await backdateRun(id, runId, 5 * 60 * 60_000);
    expect((await getTrackState(track.id, id)).runs.find((r) => r.id === runId).status).toBe('rendering');
    await backdateRun(id, runId, 25 * 60 * 60_000);
    expect((await getTrackState(track.id, id)).runs.find((r) => r.id === runId).status).toBe('error');
  });
});

describe('registry-derived authoring shape (#3136)', () => {
  it('authors a directional track across every facing and a non-directional one across row 0 only', () => {
    // The rule the two clones each hardcoded — `SPRITE_DIRECTIONS.every(...)` in
    // one and "freeze on first approval" in the other — now derived from
    // `directional`, which is what decides when a set is complete.
    expect(trackAuthoringDirections(SCANNER_TRACK)).toHaveLength(8);
    expect(trackAuthoringDirections(SCANNER_TRACK)[0]).toBe('south');
    expect(trackAuthoringDirections(AMBIENT_TRACK)).toEqual(['south']);
  });

  it('keeps each track\'s on-disk set path in the shape its clone wrote', () => {
    // Load-bearing for upgrades: installs already hold approved sets at these
    // exact paths, and the atlas compiler re-verifies the evidence chain by them.
    expect(trackSetRelPath(SCANNER_TRACK, 'pioneer')).toBe('scanner/pioneer-scanner-set-v1.json');
    expect(trackSetRelPath(AMBIENT_TRACK, 'willow')).toBe('ambient/willow-ambient-set-v1.json');
  });

  it('throws for an unregistered track rather than defaulting to walk', async () => {
    // The sentinel rule: a mis-keyed track must not silently author walk state.
    await expect(getTrackState('jetpack', 'pioneer')).rejects.toThrow(/Unknown animation track 'jetpack'/);
  });

  it('reopens a finalized non-directional row while retaining its evidence', async () => {
    const id = newId();
    await records.createRecord({ kind: 'place', name: 'Example Willow' }, id);
    const runId = 'ambient-approved-run';
    const recordDir = join(TEST_ROOT, 'sprites', id);
    await mkdir(join(recordDir, 'ambient'), { recursive: true });
    await mkdir(join(recordDir, 'runs', runId), { recursive: true });
    await writeFile(join(recordDir, 'runs', runId, 'animation-run.json'), JSON.stringify({
      track: AMBIENT_TRACK,
      id: runId,
      status: 'candidate',
    }));
    await writeFile(join(recordDir, `ambient/${id}-ambient-selection-v1.json`), JSON.stringify({
      kind: 'reviewed-single-row-ambient-selection',
      status: 'complete',
      directions: { south: { status: 'approved', runId } },
    }));
    await writeFile(join(recordDir, trackSetRelPath(AMBIENT_TRACK, id)), JSON.stringify({
      kind: 'finalized-single-row-ambient-set',
      directions: { south: { status: 'approved', runId } },
    }));

    const reopened = await reopenTrackDirection(AMBIENT_TRACK, id);
    expect(reopened.set).toBeNull();
    expect(reopened.selection.status).toBe('in-progress');
    expect(reopened.selection.directions).toEqual({});
    expect(reopened.runs.find((run) => run.id === runId)).toMatchObject({
      status: 'superseded',
      supersededReason: 'manual-track-revision',
    });
  });
});

describe('recordsCarryingTrack (#3153)', () => {
  // The evidence scan behind the CRUD surface's in-use refusal: deleting a track (or
  // flipping its facing mode) with approved renders on disk would orphan artifacts
  // the atlas compiler re-verifies by their `setKind`/`selectionKind`. The refusal
  // itself is asserted in animationTrackCrud.test.js; what only this module can get
  // wrong is which on-disk shapes count as "carrying" the track.
  const writeArtifact = async (recordId, relPath, doc) => {
    const abs = join(TEST_ROOT, 'sprites', recordId, relPath);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, JSON.stringify(doc));
  };

  it('is empty when no record carries the track', async () => {
    await records.createRecord({ kind: 'character', name: 'Placeholder Hero' }, newId());
    expect(await recordsCarryingTrack(SCANNER_TRACK)).toEqual([]);
  });

  it('counts a FINALIZED set', async () => {
    const id = newId();
    await records.createRecord({ kind: 'character', name: 'Placeholder Hero' }, id);
    await writeArtifact(id, trackSetRelPath(SCANNER_TRACK, id), { kind: 'finalized-eight-direction-scanner-set' });
    expect(await recordsCarryingTrack(SCANNER_TRACK)).toEqual([id]);
  });

  it('counts a selection with at least one APPROVED direction, before the set freezes', async () => {
    // A directional track with seven approvals has no set yet — but those seven are
    // renders the user approved, so a set-only check would let the delete through and
    // orphan them.
    const id = newId();
    await records.createRecord({ kind: 'character', name: 'Placeholder Hero' }, id);
    await writeArtifact(id, `${SCANNER_TRACK}/${id}-${SCANNER_TRACK}-selection-v1.json`, {
      kind: 'reviewed-directional-scanner-selection',
      directions: { east: { status: 'approved' }, north: { status: 'candidate' } },
    });
    expect(await recordsCarryingTrack(SCANNER_TRACK)).toEqual([id]);
  });

  it('does NOT count an in-progress selection with no approvals', async () => {
    // An unapproved candidate is re-derivable work the user has not committed to, so
    // it must not block a delete — otherwise a single abandoned render permanently
    // pins the track.
    const id = newId();
    await records.createRecord({ kind: 'character', name: 'Placeholder Hero' }, id);
    await writeArtifact(id, `${SCANNER_TRACK}/${id}-${SCANNER_TRACK}-selection-v1.json`, {
      kind: 'reviewed-directional-scanner-selection',
      directions: { east: { status: 'candidate' } },
    });
    expect(await recordsCarryingTrack(SCANNER_TRACK)).toEqual([]);
  });

  it('scopes to the asked-for track, so another track\'s work never blocks this one', async () => {
    const id = newId();
    await records.createRecord({ kind: 'place', name: 'Example Willow' }, id);
    await writeArtifact(id, trackSetRelPath(AMBIENT_TRACK, id), { kind: 'finalized-single-row-ambient-set' });
    expect(await recordsCarryingTrack(AMBIENT_TRACK)).toEqual([id]);
    expect(await recordsCarryingTrack(SCANNER_TRACK)).toEqual([]);
  });
});
