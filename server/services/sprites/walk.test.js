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
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { createHash } from 'crypto';
import { lockAllAnchors } from './spriteTestFixtures.js';

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

// Walk generation now runs grok as an observable TUI session (executeTuiRun)
// rather than a headless media-job. Default mock returns a promise that never
// resolves, so the fire-and-forget render started by startWalkGeneration does
// NOT race the test with a background attach; a happy-path test overrides it
// with mockImplementationOnce to simulate grok writing the MP4.
const executeTuiRun = vi.fn(() => new Promise(() => {}));
vi.mock('../../lib/tuiPromptRunner.js', () => ({
  executeTuiRun: (...args) => executeTuiRun(...args),
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
vi.mock('../videoGen/grok.js', () => ({ GROK_VIDEO_DURATIONS: [1, 2, 3, 6, 10] }));

const prepareWalkAnchorChromaInput = vi.fn(async (_anchorAbs, destAbs) => {
  await mkdir(join(destAbs, '..'), { recursive: true });
  await writeFile(destAbs, 'stub-chroma-anchor');
  return { preparation: 'composited-over-solid-chroma-matte' };
});
const runWalkPostprocess = vi.fn(async ({ runRel, runAbs }) => {
  // Faithfully land the packed strip on disk (the real postprocess writes it) —
  // getWalkState's missing-strip guard now flips a candidate whose strip is
  // absent to an error, so a mock that only returns the path would look broken.
  await mkdir(join(runAbs, 'generated'), { recursive: true });
  await writeFile(join(runAbs, 'generated', 'strip.png'), 'packaged-strip-bytes');
  return {
    manifestPath: `${runRel}/generated/manifest.json`,
    stripPreview: { stripPath: `${runRel}/generated/strip.png`, frameCount: 8, fps: 12, cellWidth: 384, cellHeight: 384, row: 0, startColumn: 0 },
  };
});
vi.mock('./walkPostprocess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    prepareWalkAnchorChromaInput: (...args) => prepareWalkAnchorChromaInput(...args),
    runWalkPostprocess: (...args) => runWalkPostprocess(...args),
  };
});

const records = await import('./records.js');
const { listSpriteAssets } = await import('./paths.js');
const { lockReference } = await import('./reference.js');
const {
  getWalkState, startWalkGeneration, attachTuiWalkResult, approveWalkDirection, rerunWalkPostprocess, unlockWalkSet,
  reopenWalkDirection, setWalkTarget,
} = await import('./walk.js');
const { SPRITE_DIRECTIONS, ANCHOR_DIRECTIONS } = await import('./prompts.js');

let seq = 0;
const newId = () => `walker-${++seq}`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function characterWithLockedAnchors(id, directions = ['east']) {
  await records.createRecord({ kind: 'character', name: 'Walker' }, id);
  await lockAllAnchors(TEST_ROOT, id, { lockReference, directions });
  return id;
}

// `anchored: true` builds the run the way the source-pipeline importer leaves
// it (#2978): every embedded path stays anchored at the SOURCE repo root
// (`art-source/sprites/<id>/…`) because the importer copies manifests
// byte-for-byte against pinned hashes. Readers must re-anchor at read time.
async function makeCandidateRun(recordId, direction, {
  stripBytes = `strip-${direction}`, anchored = false, frameCount = 8, fps = 12,
} = {}) {
  const runId = `walk-${direction}-${(seq++).toString(16).padStart(8, '0')}`;
  const runDir = join(TEST_ROOT, 'sprites', recordId, 'runs', runId, 'generated');
  await mkdir(runDir, { recursive: true });
  const stripName = `${recordId}-walk-${direction}-strip.png`;
  await writeFile(join(runDir, stripName), stripBytes);
  const anchor = (rel) => (anchored ? `art-source/sprites/${recordId}/${rel}` : rel);
  const stripRel = `runs/${runId}/generated/${stripName}`;
  const packaged = {
    schemaVersion: 1,
    kind: 'deterministically-packaged-grok-walk-video',
    characterId: recordId,
    direction,
    frameRate: fps,
    frameCount,
    stripPath: anchor(stripRel),
    stripSha256: sha256(Buffer.from(stripBytes)),
  };
  const manifestRel = `runs/${runId}/generated/${recordId}-walk-${direction}-manifest.json`;
  await writeFile(join(runDir, `${recordId}-walk-${direction}-manifest.json`), JSON.stringify(packaged));
  await writeFile(join(TEST_ROOT, 'sprites', recordId, 'runs', runId, 'animation-run.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'grok-game-animation-frames-run',
    status: 'candidate',
    id: runId,
    characterId: recordId,
    direction,
    chromaKey: '#FF00FF',
    createdAt: new Date().toISOString(),
    postprocessManifest: anchor(manifestRel),
    // Real candidate records carry the packed-strip preview the UI renders.
    // The importer stamps it as `path` (repo-anchored); PortOS uses `stripPath`.
    stripPreview: {
      ...(anchored ? { path: anchor(stripRel) } : { stripPath: stripRel }),
      frameCount, fps, cellWidth: 384, cellHeight: 384, row: 0, startColumn: 0,
    },
  }));
  return { runId, manifestRel };
}

beforeEach(() => {
  executeTuiRun.mockClear();
  executeTuiRun.mockImplementation(() => new Promise(() => {}));
  prepareWalkAnchorChromaInput.mockClear();
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

  it('starts an observable grok-tui render off a locked anchor', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const result = await startWalkGeneration(id, { direction: 'east' });
    expect(result.runId).toMatch(/^walk-east-[0-9a-f]{8}$/);
    expect(result.duration).toBe(6); // walk default (WALK_DEFAULT_DURATION — grok's real floor)
    // The shell session id is the run id, so the card can deep-link to /shell/<id>.
    expect(result.shellSession).toBe(result.runId);

    // grok runs as a TUI session (not a media job) so the user can watch it.
    expect(executeTuiRun).toHaveBeenCalledOnce();
    const call = executeTuiRun.mock.calls[0][0];
    expect(call.runId).toBe(result.runId);
    expect(call.provider).toMatchObject({ id: 'grok-tui', type: 'tui', command: '/usr/local/bin/grok' });
    expect(call.workspacePath).toBe(join(TEST_ROOT, 'sprites', id, 'runs', result.runId, 'generated'));
    // The task points grok at the chroma-backed input and the exact MP4 path.
    expect(call.prompt).toContain('walking east');
    expect(call.prompt).toContain('magenta (#FF00FF)');
    expect(call.prompt).toContain(join(TEST_ROOT, 'sprites', id, 'runs', result.runId, 'generated', 'input-anchor-chroma.png'));
    expect(call.prompt).toContain(join(TEST_ROOT, 'sprites', id, 'runs', result.runId, 'generated', 'source-video.mp4'));
    expect(call.idleMs).toBeGreaterThan(8000); // longer than the default one-shot idle

    // Chroma-backed input prepared from the anchor; run persisted as 'rendering'
    // with the shell session id.
    expect(prepareWalkAnchorChromaInput).toHaveBeenCalledOnce();
    const { runs } = await getWalkState(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: result.runId, status: 'rendering', provider: 'grok-tui', shellSession: result.runId,
      direction: 'east', chromaKey: '#FF00FF',
    });
    expect(runs[0].animationInputPreparation).toBe('composited-over-solid-chroma-matte');
  });

  it('honors duration 10 (passed to the grok task)', async () => {
    const id = await characterWithLockedAnchors(newId(), []);
    const result = await startWalkGeneration(id, { direction: 'south', duration: 10 });
    expect(result.duration).toBe(10);
    expect(executeTuiRun.mock.calls[0][0].prompt).toContain('for 10 seconds');
  });

  it('falls back to the default clip length for a duration grok does not offer', async () => {
    // Values outside GROK_VIDEO_DURATIONS fall back to WALK_DEFAULT_DURATION (6).
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const result = await startWalkGeneration(id, { direction: 'east', duration: 5 });
    expect(result.duration).toBe(6);
    expect(executeTuiRun.mock.calls[0][0].prompt).toContain('for 6 seconds');
  });

  it('stores the chosen frame count + fps on the run and passes them to the packer', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    // Frame count / fps are pinned at the SET level now (#2985) — a render must
    // agree with the target, so pin it first, then generate against it.
    await setWalkTarget(id, { frameCount: 14, fps: 8 });
    executeTuiRun.mockImplementationOnce(async ({ workspacePath }) => {
      await writeFile(join(workspacePath, 'source-video.mp4'), 'grok-clip-bytes');
    });
    const { runId } = await startWalkGeneration(id, { direction: 'east', frameCount: 14, fps: 8 });
    await vi.waitFor(async () => {
      const { runs } = await getWalkState(id);
      expect(runs[0].status).toBe('candidate');
    });
    const { runs } = await getWalkState(id);
    expect(runs[0]).toMatchObject({ id: runId, frameCount: 14, fps: 8 });
    expect(runWalkPostprocess.mock.calls[0][0]).toMatchObject({ frameCount: 14, fps: 8 });
  });

  it('packages the candidate once grok writes the clip (full render→attach)', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    // Simulate grok saving the MP4 to the directed path, then finishing.
    executeTuiRun.mockImplementationOnce(async ({ workspacePath }) => {
      await writeFile(join(workspacePath, 'source-video.mp4'), 'grok-clip-bytes');
    });
    const { runId } = await startWalkGeneration(id, { direction: 'east' });
    // The render + attach run fire-and-forget after generation returns.
    await vi.waitFor(async () => {
      const { runs } = await getWalkState(id);
      expect(runs[0].status).toBe('candidate');
    });
    expect(runWalkPostprocess).toHaveBeenCalledOnce();
    const { runs } = await getWalkState(id);
    expect(runs[0]).toMatchObject({
      id: runId, status: 'candidate', postprocessManifest: `runs/${runId}/generated/manifest.json`,
    });
    expect(runs[0].sourceVideoSha256).toBe(sha256(Buffer.from('grok-clip-bytes')));
  });

  it('marks the run errored when grok finishes without a clip', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    executeTuiRun.mockImplementationOnce(async () => {}); // resolves, writes no MP4
    await startWalkGeneration(id, { direction: 'east' });
    await vi.waitFor(async () => {
      const { runs } = await getWalkState(id);
      expect(runs[0].status).toBe('error');
    });
    const { runs } = await getWalkState(id);
    expect(runs[0].postprocessError).toMatch(/without writing the walk video/);
    expect(runWalkPostprocess).not.toHaveBeenCalled();
  });

  it('refuses a second render while one is already in flight for the direction', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    // Default executeTuiRun mock never resolves → the first run stays 'rendering'.
    await startWalkGeneration(id, { direction: 'east' });
    await expect(startWalkGeneration(id, { direction: 'east' }))
      .rejects.toMatchObject({ code: 'WALK_RENDER_IN_PROGRESS' });
    expect(executeTuiRun).toHaveBeenCalledTimes(1); // the second never dispatched
  });

  it('treats a long-stale rendering run as errored and allows regenerating it', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    // A run left 'rendering' by a server that died mid-render, well past the cap.
    const staleId = 'walk-east-deadbeef';
    await mkdir(join(TEST_ROOT, 'sprites', id, 'runs', staleId, 'generated'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'sprites', id, 'runs', staleId, 'animation-run.json'), JSON.stringify({
      schemaVersion: 1, id: staleId, status: 'rendering', characterId: id, direction: 'east',
      chromaKey: '#FF00FF', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }));
    const { runs } = await getWalkState(id);
    const stale = runs.find((r) => r.id === staleId);
    expect(stale.status).toBe('error');
    expect(stale.postprocessError).toMatch(/interrupted/);
    // The in-flight guard must NOT treat a stale run as live — regeneration works.
    const result = await startWalkGeneration(id, { direction: 'east' });
    expect(result.runId).toMatch(/^walk-east-[0-9a-f]{8}$/);
    expect(result.runId).not.toBe(staleId);
  });
});

describe('attachTuiWalkResult (grok-tui completion)', () => {
  // Write a source video directly into a run's generated dir (grok's TUI run
  // saves it there in production) and return its abs path.
  async function landVideo(id, runId, bytes = 'grok-clip') {
    const videoAbs = join(TEST_ROOT, 'sprites', id, 'runs', runId, 'generated', 'source-video.mp4');
    await mkdir(join(videoAbs, '..'), { recursive: true });
    await writeFile(videoAbs, bytes);
    return videoAbs;
  }

  it('refuses to attach onto an approved run (a late render must not overwrite frozen evidence)', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const { runId } = await makeCandidateRun(id, 'east');
    await approveWalkDirection(id, { direction: 'east', runId });
    const videoAbs = await landVideo(id, runId, 'late');
    runWalkPostprocess.mockClear();
    await attachTuiWalkResult(id, runId, videoAbs);
    expect(runWalkPostprocess).not.toHaveBeenCalled();
    const { runs } = await getWalkState(id);
    expect(runs.find((r) => r.id === runId).status).toBe('candidate'); // untouched
  });

  it('refuses to attach after the walk set is finalized', async () => {
    const id = await characterWithLockedAnchors(newId(), ANCHOR_DIRECTIONS);
    for (const direction of SPRITE_DIRECTIONS) {
      const { runId } = await makeCandidateRun(id, direction);
      await approveWalkDirection(id, { direction, runId }); // eslint-disable-line no-await-in-loop
    }
    const staleRunId = 'walk-east-0badc0de';
    await mkdir(join(TEST_ROOT, 'sprites', id, 'runs', staleRunId, 'generated'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'sprites', id, 'runs', staleRunId, 'animation-run.json'), JSON.stringify({
      schemaVersion: 1, id: staleRunId, status: 'rendering', characterId: id, direction: 'east', chromaKey: '#FF00FF',
    }));
    const videoAbs = await landVideo(id, staleRunId, 'late');
    runWalkPostprocess.mockClear();
    await attachTuiWalkResult(id, staleRunId, videoAbs);
    expect(runWalkPostprocess).not.toHaveBeenCalled();
  });

  it('skips silently when the run record is missing', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const videoAbs = await landVideo(id, 'walk-east-deadbeef');
    await attachTuiWalkResult(id, 'walk-east-deadbeef', videoAbs); // no throw
    expect(runWalkPostprocess).not.toHaveBeenCalled();
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
    const videoAbs = join(TEST_ROOT, 'sprites', id, 'runs', runId, 'generated', 'source-video.mp4');
    await writeFile(videoAbs, 'landed');
    const run = await rerunWalkPostprocess(id, { runId });
    expect(run.status).toBe('candidate');

    // Approve it (needs a packaged manifest + strip on disk), then rerun 409s.
    const { runId: approvedRun } = await makeCandidateRun(id, 'east');
    await writeFile(join(TEST_ROOT, 'sprites', id, 'runs', approvedRun, 'generated', 'source-video.mp4'), 'landed');
    await approveWalkDirection(id, { direction: 'east', runId: approvedRun });
    await expect(rerunWalkPostprocess(id, { runId: approvedRun }))
      .rejects.toMatchObject({ code: 'RUN_APPROVED' });
  });

  it('reprocesses the on-disk clip at a new frame count + fps (no regeneration)', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    await setWalkTarget(id, { frameCount: 8, fps: 12 });
    const { runId } = await startWalkGeneration(id, { direction: 'east', frameCount: 8, fps: 12 });
    await writeFile(join(TEST_ROOT, 'sprites', id, 'runs', runId, 'generated', 'source-video.mp4'), 'landed');
    runWalkPostprocess.mockClear();
    // Retargeting the SET is what unlocks a reprocess at a new geometry — the
    // reprocess is how a drifted direction is brought back into line.
    await setWalkTarget(id, { frameCount: 16, fps: 6 });
    const run = await rerunWalkPostprocess(id, { runId, frameCount: 16, fps: 6 });
    // The override reaches the deterministic packer — same clip, new count/fps.
    expect(runWalkPostprocess).toHaveBeenCalledOnce();
    expect(runWalkPostprocess.mock.calls[0][0]).toMatchObject({ frameCount: 16, fps: 6 });
    // …and is stamped back onto the run record so the card reflects the choice.
    expect(run).toMatchObject({ frameCount: 16, fps: 6 });
  });
});

// #2985: the cycle geometry is pinned per SET and enforced when each render is
// queued, instead of surfacing as an atlas-compile wall eight renders later.
describe('walk cycle target', () => {
  const readSelection = (id) => readFile(
    join(TEST_ROOT, 'sprites', id, 'walk', `${id}-walk-selection-v1.json`), 'utf8',
  ).then(JSON.parse);

  it('derives the target from the first packaged direction and reports drift', async () => {
    // The exact shape this issue exists for: one direction packed at 12 frames
    // and the rest at 8. It must LOAD, resolve a target, and name the drifted
    // directions — not throw, and not wait until compile to complain.
    const id = await characterWithLockedAnchors(newId(), SPRITE_DIRECTIONS);
    await makeCandidateRun(id, 'south', { frameCount: 12, fps: 10 });
    await makeCandidateRun(id, 'east');
    await makeCandidateRun(id, 'west');
    const { walkTarget } = await getWalkState(id);
    expect(walkTarget).toMatchObject({ frameCount: 12, fps: 10, source: 'derived' });
    expect(walkTarget.drift.map((d) => d.direction).sort()).toEqual(['east', 'west']);
    expect(walkTarget.drift[0]).toMatchObject({ frameCount: 8, fps: 12, frameCountDrifts: true });
  });

  it('resolves the target from the bound app\'s runtime contract and refuses to override it', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    await records.updateRecord(id, {
      publishBinding: { appId: 'example-game', runtimeContract: { walkFrameCount: 16 } },
    });
    const { walkTarget } = await getWalkState(id);
    expect(walkTarget).toMatchObject({
      frameCount: 16, source: 'app', frameCountLocked: true, appId: 'example-game',
    });
    // Per-render override → refused; the app decides what its atlas may hold.
    await expect(startWalkGeneration(id, { direction: 'east', frameCount: 12, fps: 10 }))
      .rejects.toMatchObject({ code: 'WALK_TARGET_MISMATCH' });
    // …and so is retargeting the set behind the contract's back.
    await expect(setWalkTarget(id, { frameCount: 12, fps: 10 }))
      .rejects.toMatchObject({ code: 'WALK_TARGET_LOCKED' });
  });

  it('409s a generate whose geometry disagrees with the target, naming both values', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east', 'west']);
    await setWalkTarget(id, { frameCount: 12, fps: 10 });
    await expect(startWalkGeneration(id, { direction: 'east', frameCount: 8, fps: 10 }))
      .rejects.toMatchObject({
        code: 'WALK_TARGET_MISMATCH',
        status: 409,
        message: expect.stringContaining('targets 12 frames @ 10fps'),
      });
    await expect(startWalkGeneration(id, { direction: 'east', frameCount: 12, fps: 24 }))
      .rejects.toMatchObject({ code: 'WALK_TARGET_MISMATCH' });
    expect(executeTuiRun).not.toHaveBeenCalled();
    // A matching request goes through, and an omitted geometry adopts the target.
    const matching = await startWalkGeneration(id, { direction: 'east', frameCount: 12, fps: 10 });
    expect(matching.runId).toMatch(/^walk-east-/);
    await startWalkGeneration(id, { direction: 'west' });
    const { runs } = await getWalkState(id);
    expect(runs.every((r) => r.frameCount === 12 && r.fps === 10)).toBe(true);
  });

  it('409s a reprocess whose geometry disagrees with the target', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const { runId } = await startWalkGeneration(id, { direction: 'east' });
    await writeFile(join(TEST_ROOT, 'sprites', id, 'runs', runId, 'generated', 'source-video.mp4'), 'landed');
    runWalkPostprocess.mockClear();
    await expect(rerunWalkPostprocess(id, { runId, frameCount: 6, fps: 10 }))
      .rejects.toMatchObject({ code: 'WALK_TARGET_MISMATCH' });
    expect(runWalkPostprocess).not.toHaveBeenCalled();
    // Omitting the geometry adopts the target rather than 409ing.
    await rerunWalkPostprocess(id, { runId });
    expect(runWalkPostprocess.mock.calls[0][0]).toMatchObject({ frameCount: 12, fps: 10 });
  });

  it('persists an explicit target track-keyed, preserving an unknown sibling track', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    await setWalkTarget(id, { frameCount: 12, fps: 10 });
    // Simulate a newer PortOS (or a peer) having written a track this build
    // knows nothing about — it must survive the next write untouched.
    const selection = await readSelection(id);
    selection.animationTargets.scanner = { frameCount: 4, fps: 6, source: 'set' };
    await writeFile(
      join(TEST_ROOT, 'sprites', id, 'walk', `${id}-walk-selection-v1.json`),
      JSON.stringify(selection),
    );
    const state = await setWalkTarget(id, { frameCount: 14, fps: 8 });
    expect(state.walkTarget).toMatchObject({ frameCount: 14, fps: 8, source: 'set' });
    expect(await readSelection(id)).toMatchObject({
      animationTargets: {
        walk: { frameCount: 14, fps: 8, source: 'set' },
        scanner: { frameCount: 4, fps: 6, source: 'set' },
      },
    });
  });

  it('lazily pins a derived target on the first write, stamped as derived', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east', 'west']);
    await makeCandidateRun(id, 'east');
    // Nothing written yet — a read never mutates the record, so an older peer
    // keeps seeing exactly what it wrote.
    expect((await getWalkState(id)).walkTarget).toMatchObject({ frameCount: 8, fps: 12, source: 'derived' });
    await expect(readSelection(id)).rejects.toThrow();
    // The first write path resolves it and records it, so it stops being implicit.
    await startWalkGeneration(id, { direction: 'west', frameCount: 8, fps: 12 });
    expect((await readSelection(id)).animationTargets.walk)
      .toEqual({ frameCount: 8, fps: 12, source: 'derived' });
    expect((await getWalkState(id)).walkTarget).toMatchObject({ source: 'derived' });
  });

  it('409s approving a direction that drifts from the target, so a ragged set can\'t finalize', async () => {
    // Retargeting mid-set is a sanctioned action, so the queue-time gate alone
    // leaves a hole: approve one direction at the old target, retarget, approve
    // the rest, and the ragged set only fails at atlas-compile time — exactly
    // the failure this issue moves earlier. Approval is where geometry is frozen
    // into the compiled set, so the target has to hold there too.
    const id = await characterWithLockedAnchors(newId(), SPRITE_DIRECTIONS);
    const { runId } = await makeCandidateRun(id, 'south', { frameCount: 12, fps: 10 });
    await approveWalkDirection(id, { direction: 'south', runId });
    const { runId: eastId } = await makeCandidateRun(id, 'east', { frameCount: 8, fps: 10 });
    await expect(approveWalkDirection(id, { direction: 'east', runId: eastId }))
      .rejects.toMatchObject({
        code: 'WALK_TARGET_MISMATCH',
        message: expect.stringContaining('targets 12 frames @ 10fps'),
      });
    // The drifted direction stays unapproved rather than half-recorded.
    const { selection } = await getWalkState(id);
    expect(selection.directions.east).toBeUndefined();
  });

  it('409s a retarget on a finalized set', async () => {
    const id = await characterWithLockedAnchors(newId(), SPRITE_DIRECTIONS);
    for (const direction of SPRITE_DIRECTIONS) {
      const { runId } = await makeCandidateRun(id, direction);
      await approveWalkDirection(id, { direction, runId });
    }
    await expect(setWalkTarget(id, { frameCount: 14, fps: 8 }))
      .rejects.toMatchObject({ code: 'WALK_SET_FINAL' });
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
      join(TEST_ROOT, 'sprites', id, 'runs', runId, 'generated', `${id}-walk-east-strip.png`),
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
      status: 'approved', runId, runPath: `runs/${runId}`, runManifest: manifestRel,
    });
    expect(state.selection.directions.east.runManifestSha256).toBe(
      sha256(await readFile(join(TEST_ROOT, 'sprites', id, manifestRel))),
    );
    expect(state.walkSet).toBeNull();
  });

  // #2978: an imported run's postprocessManifest and the manifest's own
  // stripPath are both anchored at the source repo root. Resolved raw they
  // produce a doubled non-existent path, so approval 409'd RUN_MANIFEST_INVALID
  // on art that is present and intact.
  it('approves an imported run whose manifest paths are art-source/-anchored', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const { runId, manifestRel } = await makeCandidateRun(id, 'east', { anchored: true });
    const state = await approveWalkDirection(id, { direction: 'east', runId });
    expect(state.selection.directions.east).toMatchObject({
      // The selection stores the RE-ANCHORED path — it's PortOS-owned state,
      // unlike the hash-pinned imported manifest it points at.
      status: 'approved', runId, runManifest: manifestRel,
    });
    // Pin WHICH file was hashed, not merely that something was: the whole bug is
    // that the anchored path resolved to a file that isn't there, so a shape-only
    // assertion would pass over a hash of the wrong (or a missing) manifest.
    expect(state.selection.directions.east.runManifestSha256).toBe(
      sha256(await readFile(join(TEST_ROOT, 'sprites', id, manifestRel))),
    );
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
      // A native walk set is NOT an import, so the client gets its Unlock button.
      imported: false,
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

describe('unlockWalkSet', () => {
  async function finalizedCharacter() {
    const id = await characterWithLockedAnchors(newId(), ANCHOR_DIRECTIONS);
    for (const direction of SPRITE_DIRECTIONS) {
      const { runId } = await makeCandidateRun(id, direction);
      await approveWalkDirection(id, { direction, runId });
    }
    return id;
  }

  it('409s when there is no finalized walk set', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    await expect(unlockWalkSet(id)).rejects.toMatchObject({ code: 'WALK_SET_NOT_FINAL' });
  });

  it('un-freezes the set, re-opens every direction, and reverts the record status', async () => {
    const id = await finalizedCharacter();
    expect((await records.getRecord(id)).status).toBe('walk-complete');

    const state = await unlockWalkSet(id);
    // The frozen set is gone and the selection is back to an editable, empty set.
    expect(state.walkSet).toBeNull();
    expect(state.selection.status).toBe('in-progress');
    expect(state.selection.directions).toEqual({});
    expect((await records.getRecord(id)).status).toBe('reference-complete');

    // Regeneration/approval is allowed again (no WALK_SET_FINAL), and the
    // already-rendered clips remain on disk to re-approve.
    const { runId } = await makeCandidateRun(id, 'east');
    const reapproved = await approveWalkDirection(id, { direction: 'east', runId });
    expect(reapproved.selection.directions.east.status).toBe('approved');
  });

  it('refuses to unlock a legacy source-pipeline import', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    await mkdir(join(TEST_ROOT, 'sprites', id, 'walk'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'sprites', id, 'walk', `${id}-walk-set-v1.json`), JSON.stringify({
      schemaVersion: 1,
      kind: 'finalized-eight-direction-walk-set',
      characterId: id,
      status: 'final',
      // The importer copies this source-repo-anchored, which marks it legacy.
      selectionPath: `art-source/sprites/${id}/walk/${id}-walk-selection-v1.json`,
      directions: {},
    }));
    // The client keys its Unlock affordance off this flag: a legacy import
    // must surface imported:true so the button is hidden rather than offered
    // and then 409'd.
    expect((await getWalkState(id)).walkSet.imported).toBe(true);
    await expect(unlockWalkSet(id)).rejects.toMatchObject({ code: 'LEGACY_IMPORTED_WALK_SET' });
  });
});

describe('reopenWalkDirection', () => {
  async function finalizedCharacter() {
    const id = await characterWithLockedAnchors(newId(), ANCHOR_DIRECTIONS);
    for (const direction of SPRITE_DIRECTIONS) {
      const { runId } = await makeCandidateRun(id, direction);
      await approveWalkDirection(id, { direction, runId });
    }
    return id;
  }

  it('reopens ONE approved direction, un-finalizes the set, and keeps the others', async () => {
    const id = await finalizedCharacter();
    expect((await records.getRecord(id)).status).toBe('walk-complete');

    const state = await reopenWalkDirection(id, { direction: 'east' });
    // The frozen set is gone (a set is final only when all 8 are approved)…
    expect(state.walkSet).toBeNull();
    expect((await records.getRecord(id)).status).toBe('reference-complete');
    // …east is editable again while every other direction stays approved.
    expect(state.selection.directions.east).toBeUndefined();
    expect(state.selection.directions.north.status).toBe('approved');
    expect(state.selection.status).toBe('in-progress');

    // Re-approving just east re-freezes the set with a single click.
    const { runId } = await makeCandidateRun(id, 'east');
    const reapproved = await approveWalkDirection(id, { direction: 'east', runId });
    expect(reapproved.walkSet).not.toBeNull();
    expect((await records.getRecord(id)).status).toBe('walk-complete');
  });

  it('409s a direction that is not approved', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    await expect(reopenWalkDirection(id, { direction: 'east' }))
      .rejects.toMatchObject({ code: 'DIRECTION_NOT_APPROVED' });
  });

  it('refuses to reopen a legacy source-pipeline import', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    await mkdir(join(TEST_ROOT, 'sprites', id, 'walk'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'sprites', id, 'walk', `${id}-walk-set-v1.json`), JSON.stringify({
      schemaVersion: 1,
      kind: 'finalized-eight-direction-walk-set',
      characterId: id,
      status: 'final',
      selectionPath: `art-source/sprites/${id}/walk/${id}-walk-selection-v1.json`,
      directions: { east: { status: 'approved' } },
    }));
    await expect(reopenWalkDirection(id, { direction: 'east' }))
      .rejects.toMatchObject({ code: 'LEGACY_IMPORTED_WALK_SET' });
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
    expect(await getWalkState(id)).toEqual({
      runs: [],
      selection: null,
      walkSet: null,
      // A fresh set has nothing pinned and nothing packaged, so the target is
      // the documented default with no drift (#2985).
      walkTarget: {
        track: 'walk',
        frameCount: 12,
        fps: 10,
        source: 'default',
        sourceLabel: 'default',
        frameCountLocked: false,
        fpsLocked: false,
        appId: null,
        drift: [],
      },
    });
    await startWalkGeneration(id, { direction: 'east' });
    await new Promise((r) => { setTimeout(r, 5); });
    const second = await startWalkGeneration(id, { direction: 'west' });
    const { runs } = await getWalkState(id);
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe(second.runId);
  });

  // A candidate/approved run whose packed strip PNG has gone missing on disk
  // (a botched migration or manual cleanup dropped it — how pioneer's north/west
  // strips silently vanished) must NOT surface as a healthy run: the native
  // render path otherwise hands the client a stripPath that 404s into a blank
  // StripLoop. getWalkState flags it with stripMissing and drops the dangling
  // stripPath, WITHOUT flipping status to 'error' (which would mis-drive the
  // client's postprocess-retry UI), and never rewrites the record on disk.
  it('flags a candidate run whose strip is missing on disk with stripMissing', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const { runId } = await makeCandidateRun(id, 'east');
    const runRecordPath = join(TEST_ROOT, 'sprites', id, 'runs', runId, 'animation-run.json');
    const bytesBefore = await readFile(runRecordPath);
    // Drop the packed strip the record advertises.
    await rm(join(TEST_ROOT, 'sprites', id, 'runs', runId, 'generated', `${id}-walk-east-strip.png`));

    const { runs } = await getWalkState(id);
    const run = runs.find((r) => r.id === runId);
    expect(run.stripMissing).toBe(true);
    // Status is preserved — a missing strip is orthogonal to postprocess status,
    // and flipping to 'error' would offer a Retry that 409s on finalized/approved.
    expect(run.status).toBe('candidate');
    // Dangling stripPath is dropped so StripLoop / the trim button don't render it.
    expect(run.stripPreview.stripPath).toBeUndefined();
    // Read-time only — the record on disk is untouched.
    expect(await readFile(runRecordPath)).toEqual(bytesBefore);
  });

  // The population this guard exists for is an APPROVED direction whose strip
  // vanished (pioneer's north/west — approved, then their strips dropped during a
  // grok/->runs/ relocation). The approved entry resolves through loadRunForEntry,
  // and the flag must ride through that path too — the run stays approved in the
  // selection (recovery there is unlock-then-regenerate, driven client-side off
  // stripMissing + finalized), never mutated to a broken 'error' run.
  it('flags an approved direction whose strip is missing without disturbing its approval', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const { runId } = await makeCandidateRun(id, 'east');
    await approveWalkDirection(id, { direction: 'east', runId });
    // Approval froze the strip on disk; now it vanishes.
    await rm(join(TEST_ROOT, 'sprites', id, 'runs', runId, 'generated', `${id}-walk-east-strip.png`));

    const { runs, selection } = await getWalkState(id);
    const run = runs.find((r) => r.id === runId);
    expect(run.stripMissing).toBe(true);
    expect(run.stripPreview.stripPath).toBeUndefined();
    expect(run.status).not.toBe('error');
    // The selection still records the direction as approved — the guard never
    // touches approval state, only the strip preview.
    expect(selection.directions.east.status).toBe('approved');
  });

  // A run whose strip IS on disk stays a healthy candidate — the guard only
  // fires on an actually-missing file, not on every read.
  it('leaves a candidate run with its strip present untouched', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const { runId } = await makeCandidateRun(id, 'east');
    const { runs } = await getWalkState(id);
    const run = runs.find((r) => r.id === runId);
    expect(run.status).toBe('candidate');
    expect(run.stripMissing).toBeUndefined();
    expect(run.stripPreview.stripPath).toBe(`runs/${runId}/generated/${id}-walk-east-strip.png`);
  });

  // Imported run records (issue #2895 importer, ElsewhereAcres source
  // pipeline) stamp createdAt as a Python time.time() epoch-seconds float
  // and stripPreview as { path: <source-repo-relative> } instead of
  // PortOS's own { stripPath: <record-relative> } — sorting the former
  // with .localeCompare threw and 500'd the whole detail endpoint, and
  // rendering the latter through spriteAssetUrl() 404'd. Both must be
  // tolerated without mutating the file on disk (its hash is pinned and
  // verified against the source manifest at import time).
  it('sorts an imported numeric-createdAt run behind a native run and normalizes its stripPreview', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const legacyRunId = 'walk-east-legacy01';
    const legacyStripRel = `grok/${legacyRunId}/generated/${id}-walk-east-strip.png`;
    const legacyDir = join(TEST_ROOT, 'sprites', id, 'grok', legacyRunId, 'generated');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, `${id}-walk-east-strip.png`), 'legacy-strip');
    const legacyPath = join(TEST_ROOT, 'sprites', id, 'grok', legacyRunId, 'animation-run.json');
    await writeFile(legacyPath, JSON.stringify({
      schemaVersion: 1,
      kind: 'grok-game-animation-frames-run',
      status: 'candidate',
      id: legacyRunId,
      characterId: id,
      direction: 'east',
      createdAt: 1700000000.123456, // source pipeline epoch-seconds float, well in the past
      stripPreview: {
        path: `art-source/sprites/${id}/${legacyStripRel}`,
        frameCount: 8, fps: 12, cellWidth: 384, cellHeight: 384, row: 0, startColumn: 0,
      },
    }));
    const legacyBytesBefore = await readFile(legacyPath);

    const { runId: nativeRunId } = await startWalkGeneration(id, { direction: 'east' });
    const { runs } = await getWalkState(id);

    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe(nativeRunId); // native ISO createdAt sorts first
    const legacy = runs.find((r) => r.id === legacyRunId);
    expect(legacy.stripPreview.stripPath).toBe(legacyStripRel);
    // Normalization happens in memory only — the imported file (and its
    // hash-pinned provenance) is never rewritten on disk.
    expect(await readFile(legacyPath)).toEqual(legacyBytesBefore);
  });

  // Issue #2928: the importer also lays source-pipeline runs down under
  // `runs/<run-id>/` rather than `grok/<run-id>/`. The selection entry names
  // the layout, so resolving runs off the entry (not off a grok-only
  // directory scan) surfaces it with no per-layout special case.
  it('resolves an approved direction whose runPath is under runs/<run-id>/', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const runId = 'walk-east-imported1';
    const stripRel = `runs/${runId}/generated/${id}-walk-east-strip.png`;
    const runDir = join(TEST_ROOT, 'sprites', id, 'runs', runId, 'generated');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, `${id}-walk-east-strip.png`), 'imported-strip');
    await writeFile(join(TEST_ROOT, 'sprites', id, 'runs', runId, 'animation-run.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'grok-game-animation-frames-run',
      status: 'candidate',
      id: runId,
      characterId: id,
      direction: 'east',
      createdAt: 1700000000.123456,
      stripPreview: {
        // Source-repo-anchored, exactly as the importer copies it.
        path: `art-source/sprites/${id}/${stripRel}`,
        frameCount: 8, fps: 12, cellWidth: 384, cellHeight: 384, row: 0, startColumn: 0,
      },
    }));
    await mkdir(join(TEST_ROOT, 'sprites', id, 'walk'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'sprites', id, 'walk', `${id}-walk-selection-v1.json`), JSON.stringify({
      schemaVersion: 1,
      kind: 'reviewed-directional-walk-selection',
      characterId: id,
      status: 'in-progress',
      directions: {
        east: {
          status: 'approved',
          runId,
          runPath: `art-source/sprites/${id}/runs/${runId}`,
          runManifest: `art-source/sprites/${id}/runs/${runId}/generated/manifest.json`,
          approvedAt: '2026-07-01T00:00:00.000Z',
        },
      },
    }));

    const { runs } = await getWalkState(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      direction: 'east',
      kind: 'grok-game-animation-frames-run',
      // The record's own source-repo-anchored stripPreview is normalized the
      // same way a grok/-layout imported run's is.
      stripPreview: { stripPath: stripRel, frameCount: 8 },
    });
  });

  // The shape the importer ACTUALLY writes: `runId` is stamped only by
  // approveWalkDirection, so a copied source-pipeline walk set carries just
  // status/runPath/runManifest (see importer.test.js's fixtures). Gating the
  // entry walk on `entry.runId` would filter out every imported direction —
  // exactly the population this read path exists for.
  it('resolves an imported entry that carries no runId, keying the run by its directory', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const runId = 'walk-east-noid0001';
    const runDir = join(TEST_ROOT, 'sprites', id, 'runs', runId, 'generated');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'strip.png'), 'imported-strip');
    // Imported run records carry no `id` field either.
    await writeFile(join(TEST_ROOT, 'sprites', id, 'runs', runId, 'animation-run.json'), JSON.stringify({
      kind: 'grok-walk-animation-run',
      status: 'candidate',
      characterId: id,
      direction: 'east',
      stripPreview: {
        path: `art-source/sprites/${id}/runs/${runId}/generated/strip.png`,
        frameCount: 8, fps: 12, cellWidth: 384, cellHeight: 384, row: 0, startColumn: 0,
      },
    }));
    await mkdir(join(TEST_ROOT, 'sprites', id, 'walk'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'sprites', id, 'walk', `${id}-walk-selection-v1.json`), JSON.stringify({
      schemaVersion: 1,
      kind: 'reviewed-directional-walk-selection',
      characterId: id,
      status: 'in-progress',
      directions: {
        east: {
          status: 'approved',
          runPath: `art-source/sprites/${id}/runs/${runId}`,
          runManifest: `art-source/sprites/${id}/runs/${runId}/generated/manifest.json`,
        },
      },
    }));

    const { runs } = await getWalkState(id);
    expect(runs).toHaveLength(1);
    // The run directory IS the run id under both layouts, so an idless
    // imported record still gets a stable key for the client's list.
    expect(runs[0].id).toBe(runId);
    expect(runs[0].stripPreview.stripPath).toBe(`runs/${runId}/generated/strip.png`);
  });

  // A `runs/`-layout entry whose record is missing on disk must surface
  // nothing rather than a half-shaped run — the grok scan can't cover it.
  it('surfaces nothing for a runs/<run-id>/ entry with no run record on disk', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    await mkdir(join(TEST_ROOT, 'sprites', id, 'walk'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'sprites', id, 'walk', `${id}-walk-selection-v1.json`), JSON.stringify({
      schemaVersion: 1,
      kind: 'reviewed-directional-walk-selection',
      characterId: id,
      status: 'in-progress',
      directions: {
        east: {
          status: 'approved', runId: 'walk-east-ghost001', runPath: 'runs/walk-east-ghost001', approvedAt: 'x',
        },
      },
    }));
    expect((await getWalkState(id)).runs).toEqual([]);
  });

  // The scan path needs the same id fallback: without it an idless scanned
  // run keys off `undefined`, which collapses the server-side dedup and makes
  // the client's `runs.find(r => r.id === sel.runId)` match the wrong
  // direction. Reverting the scan to normalizeStripPreview must fail here.
  it('keys an idless scanned grok run by its directory', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east']);
    const runId = 'walk-east-scanidless';
    await mkdir(join(TEST_ROOT, 'sprites', id, 'grok', runId), { recursive: true });
    await writeFile(join(TEST_ROOT, 'sprites', id, 'grok', runId, 'animation-run.json'), JSON.stringify({
      kind: 'grok-walk-animation-run', status: 'candidate', characterId: id, direction: 'east',
    }));
    const { runs } = await getWalkState(id);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(runId);
  });

  // Unapproved candidates and in-flight generations have no selection entry
  // by definition, so the grok/ scan is still what surfaces them alongside
  // the entry-resolved approved run.
  it('unions entry-resolved approved runs with unapproved scanned grok runs', async () => {
    const id = await characterWithLockedAnchors(newId(), ['east', 'west']);
    const { runId: approvedRunId } = await makeCandidateRun(id, 'east');
    await approveWalkDirection(id, { direction: 'east', runId: approvedRunId });
    const { runId: pendingRunId } = await startWalkGeneration(id, { direction: 'west' });

    const { runs } = await getWalkState(id);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.id).sort()).toEqual([approvedRunId, pendingRunId].sort());
    // The approved run is not duplicated by the scan.
    expect(runs.filter((r) => r.id === approvedRunId)).toHaveLength(1);
  });

  // Issue #2924: a direction approved from the source pipeline's video-first
  // imagegen REDRAW path has no grok/ run directory at all — its selection
  // entry points at imagegen/vN. Synthesize the preview from that manifest's
  // cycle block so the card animates instead of showing a bare badge.
  describe('imagegen-redraw approved directions', () => {
    const REDRAW_MANIFEST_REL = 'imagegen/v19/walk-east-v19-manifest.json';

    async function characterWithRedrawEast(id, { cycle, cellSize = 384, strips = ['clean-alpha.png'] } = {}) {
      await characterWithLockedAnchors(id, ['east']);
      const dir = join(TEST_ROOT, 'sprites', id, 'imagegen', 'v19');
      await mkdir(dir, { recursive: true });
      for (const name of strips) await writeFile(join(dir, name), `strip:${name}`);
      await writeFile(join(TEST_ROOT, 'sprites', id, REDRAW_MANIFEST_REL), JSON.stringify({
        schemaVersion: 1,
        characterId: id,
        direction: 'east',
        pipeline: 'game-animation-frames-video-first',
        cellSize,
        cycle: cycle ?? {
          frameCount: 12,
          referenceFps: 12,
          // Source-repo-anchored, exactly as the importer copies it.
          stripAlpha: `art-source/sprites/${id}/imagegen/v19/clean-alpha.png`,
          stripKeyed: `art-source/sprites/${id}/imagegen/v19/keyed.png`,
        },
      }));
      await mkdir(join(TEST_ROOT, 'sprites', id, 'walk'), { recursive: true });
      await writeFile(join(TEST_ROOT, 'sprites', id, 'walk', `${id}-walk-selection-v1.json`), JSON.stringify({
        schemaVersion: 1,
        kind: 'reviewed-directional-walk-selection',
        characterId: id,
        status: 'in-progress',
        directions: {
          east: {
            status: 'approved',
            runId: `${id}-v19-east`,
            runPath: `art-source/sprites/${id}/imagegen/v19`,
            runManifest: `art-source/sprites/${id}/${REDRAW_MANIFEST_REL}`,
            approvedAt: 'established-production-v19',
          },
        },
      }));
    }

    it('synthesizes a run with the redraw cycle geometry and the clean-alpha strip', async () => {
      const id = newId();
      await characterWithRedrawEast(id);
      const { runs } = await getWalkState(id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: `${id}-v19-east`,
        direction: 'east',
        status: 'approved',
        kind: 'imported-redraw-walk-cycle',
        redrawManifest: REDRAW_MANIFEST_REL,
        stripPreview: {
          stripPath: 'imagegen/v19/clean-alpha.png',
          frameCount: 12,
          fps: 12,
          cellWidth: 384,
          cellHeight: 384,
          row: 0,
          startColumn: 0,
        },
      });
      // toMatchObject asserts presence, not absence: pin that the redraw
      // manifest does NOT land on postprocessManifest, which approve/trim
      // resolve as a packaged grok manifest (frames[] + alignment).
      expect(runs[0].postprocessManifest).toBeUndefined();
    });

    // Same importer-shape guard as the runs/ layout above: a copied redraw
    // entry has no runId, so the synthesized run keys off its manifest path.
    it('synthesizes a redraw run for an imported entry that carries no runId', async () => {
      const id = newId();
      await characterWithRedrawEast(id);
      const selectionAbs = join(TEST_ROOT, 'sprites', id, 'walk', `${id}-walk-selection-v1.json`);
      const selection = JSON.parse(await readFile(selectionAbs, 'utf8'));
      delete selection.directions.east.runId;
      await writeFile(selectionAbs, JSON.stringify(selection));

      const { runs } = await getWalkState(id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: REDRAW_MANIFEST_REL,
        kind: 'imported-redraw-walk-cycle',
        stripPreview: { stripPath: 'imagegen/v19/clean-alpha.png', frameCount: 12 },
      });
    });

    it('ignores a traversal-shaped runManifest', async () => {
      const id = newId();
      await characterWithRedrawEast(id);
      const selectionAbs = join(TEST_ROOT, 'sprites', id, 'walk', `${id}-walk-selection-v1.json`);
      const selection = JSON.parse(await readFile(selectionAbs, 'utf8'));
      selection.directions.east.runManifest = '../../../etc/passwd.json';
      await writeFile(selectionAbs, JSON.stringify(selection));
      expect((await getWalkState(id)).runs).toEqual([]);
    });

    it('ignores an entry whose direction was not approved', async () => {
      const id = newId();
      await characterWithRedrawEast(id);
      const selectionAbs = join(TEST_ROOT, 'sprites', id, 'walk', `${id}-walk-selection-v1.json`);
      const selection = JSON.parse(await readFile(selectionAbs, 'utf8'));
      selection.directions.east.status = 'rejected';
      await writeFile(selectionAbs, JSON.stringify(selection));
      expect((await getWalkState(id)).runs).toEqual([]);
    });

    it('falls back to the keyed strip when the clean-alpha derivative is absent on disk', async () => {
      const id = newId();
      await characterWithRedrawEast(id, { strips: ['keyed.png'] });
      const { runs } = await getWalkState(id);
      expect(runs[0].stripPreview.stripPath).toBe('imagegen/v19/keyed.png');
    });

    it('surfaces nothing when no strip exists, rather than a broken preview', async () => {
      const id = newId();
      await characterWithRedrawEast(id, { strips: [] });
      expect((await getWalkState(id)).runs).toEqual([]);
    });

    it('ignores a manifest with no usable cycle frame count', async () => {
      const id = newId();
      await characterWithRedrawEast(id, {
        cycle: { frameCount: 1, stripAlpha: 'imagegen/v19/clean-alpha.png' },
      });
      expect((await getWalkState(id)).runs).toEqual([]);
    });

    // The selection is written by the real approval path, so the shadowing
    // check runs against the entry shape production actually produces.
    it('does not shadow a direction that DOES have a scanned grok run', async () => {
      const id = await characterWithLockedAnchors(newId(), ['east']);
      const { runId } = await makeCandidateRun(id, 'east');
      await approveWalkDirection(id, { direction: 'east', runId });
      const { runs } = await getWalkState(id);
      expect(runs).toHaveLength(1);
      expect(runs[0].kind).toBe('grok-game-animation-frames-run');
    });
  });
});
