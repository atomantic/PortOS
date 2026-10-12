import { describe, it, expect } from 'vitest';
import { productionReadiness, productionAlignmentBasis, approveProductionStage, carryProductionApprovals, assertShotApproval, setShotLocks } from './productionReview.js';
import { applySceneUpdate, mergeNextScene, removeScene } from './projectsLogic.js';

const WORD_PROBLEM = /bounded, positive-duration word timings/;
const SHOT_PROBLEM = /^Complete timing, action, staging, camera and transition/;
const ANCHOR_PROBLEM = /^Review lyric anchors/;

// A verified vocal song: line windows from the song's line timestamps, words from forced alignment.
function project({ words = [{ w: 'walking', startSec: 0.5, endSec: 1 }, { w: 'home', startSec: 1, endSec: 2.24 }], draftShots = [] } = {}) {
  const base = {
    id: 'p1', audioAnalysis: { durationSec: 8 },
    lyricCues: [{ id: 'c1', text: 'walking home', startSec: 0.6, endSec: 2, words }],
    castAndSets: { status: 'approved', direction: { world: { camera: 'Handheld drift', transitions: 'Hard cut on the downbeat' } } },
    scenes: [
      { sceneId: 's1', label: 'Verse', startSec: 0, endSec: 4, visualIntent: 'She looks up from the monitor', framePrompt: 'Medium shot, desk lamp' },
      { sceneId: 's2', label: 'Outro', startSec: 4, endSec: 8, visualIntent: 'Film spills onto the floor', framePrompt: 'Wide shot' },
    ],
    productionReview: { draft: { lyricsMode: 'vocal', timingStatus: 'verified', storyboard: draftShots } },
  };
  return { ...base, productionReview: { ...base.productionReview, alignmentBasis: productionAlignmentBasis(base) } };
}

describe('storyboard readiness after verified lyric timing', () => {
  it('accepts aligned words that run a little past their line window, as the renderer shows them', () => {
    const { storyboard, alignment } = productionReadiness(project());
    expect(alignment.status).toBe('verified');
    expect(storyboard.problems.some((p) => WORD_PROBLEM.test(p))).toBe(false);
  });

  it('still blocks a zero-length or missing word', () => {
    const zero = productionReadiness(project({ words: [{ w: 'walking', startSec: 0.5, endSec: 0.5 }, { w: 'home', startSec: 1, endSec: 2 }] }));
    expect(zero.storyboard.problems.some((p) => WORD_PROBLEM.test(p))).toBe(true);
    const missing = productionReadiness(project({ words: [] }));
    expect(missing.storyboard.problems.some((p) => WORD_PROBLEM.test(p))).toBe(true);
  });

  it('reads Board scenes planned without draft shots as complete, lyric-anchored shots', () => {
    const { storyboard } = productionReadiness(project());
    expect(storyboard.problems.filter((p) => SHOT_PROBLEM.test(p) || ANCHOR_PROBLEM.test(p))).toEqual([]);
    expect(storyboard.shots).toEqual([
      { sceneId: 's1', lyricCueIds: ['c1'], action: 'She looks up from the monitor', staging: 'Medium shot, desk lamp', camera: 'Handheld drift', transition: 'Hard cut on the downbeat' },
      { sceneId: 's2', lyricCueIds: [], action: 'Film spills onto the floor', staging: 'Wide shot', camera: 'Handheld drift', transition: 'Hard cut on the downbeat' },
    ]);
  });

  it('keeps a director-edited draft shot over the derived row', () => {
    const edited = { sceneId: 's1', lyricCueIds: ['c1'], action: 'She laughs', staging: 'Close-up', camera: '', transition: 'Cut' };
    const { storyboard } = productionReadiness(project({ draftShots: [edited] }));
    expect(storyboard.shots[0]).toEqual(edited);
    expect(storyboard.problems).toContain('Complete timing, action, staging, camera and transition for Verse.');
  });
});

describe('approving a Board storyboard of derived shots', () => {
  it('writes the derived rows into the draft and stays approved on that revision', () => {
    const planned = project();
    const draft = { ...planned.productionReview.draft, cast: 'The director', environments: 'Edit room', visualLanguage: 'Analog grain',
      motionLanguage: 'Slow push-ins', guideArtifactId: 'g1' };
    const ready = { ...planned, devArtifacts: [{ id: 'g1', mimeType: 'image/png', file: 'guide.png', version: 1 }],
      productionReview: { ...planned.productionReview, draft } };
    const art = approveProductionStage(ready, { stage: 'art', basis: productionReadiness(ready).basis.art });
    const before = productionReadiness(art);
    expect(before.storyboard.problems).toEqual([]);
    const approved = approveProductionStage(art, { stage: 'storyboard', basis: before.basis.storyboard });
    expect(approved.productionReview.draft.storyboard).toEqual(before.storyboard.shots);
    expect(productionReadiness(approved).storyboard.approved).toBe(true);

    // Uniquely catches a machine-only composition migration staling art and storyboard approvals.
    const composed = { ...approved, composition: { mode: 'composed' } };
    expect(productionReadiness(composed).storyboard.approved).toBe(false);
    const carried = carryProductionApprovals(approved, composed, 'compose footage');
    expect(productionReadiness(carried)).toMatchObject({ art: { approved: true }, storyboard: { approved: true } });
    expect(carried.productionReview.approvals.storyboard.carriedOver).toMatchObject({ reason: 'compose footage' });
    // A later creative change still stales it.
    expect(productionReadiness({ ...carried, concept: 'A new concept' }).storyboard.approved).toBe(false);
  });
});

describe('the director trimming an approved storyboard', () => {
  // An approved three-shot board: s1 0-4, s2 4-6, s3 6-8.
  function approvedBoard() {
    const planned = project();
    const scenes = [planned.scenes[0], { ...planned.scenes[1], sceneId: 's2', label: 'Insert', endSec: 6 },
      { ...planned.scenes[1], sceneId: 's3', startSec: 6, endSec: 8 }];
    const draft = { ...planned.productionReview.draft, cast: 'The director', environments: 'Edit room', visualLanguage: 'Analog grain',
      motionLanguage: 'Slow push-ins', guideArtifactId: 'g1' };
    const ready = { ...planned, scenes, devArtifacts: [{ id: 'g1', mimeType: 'image/png', file: 'guide.png', version: 1 }],
      productionReview: { ...planned.productionReview, draft } };
    const art = approveProductionStage(ready, { stage: 'art', basis: productionReadiness(ready).basis.art });
    return approveProductionStage(art, { stage: 'storyboard', basis: productionReadiness(art).basis.storyboard });
  }

  // Uniquely catches cutting a shot unlocking the shots it never touched.
  it('keeps untouched shots locked through a cut and unlocks only the shot stretched over the gap', () => {
    const cut = removeScene(approvedBoard(), 's2');
    expect(cut.productionReview.draft.storyboard.map((shot) => shot.sceneId)).toEqual(['s1', 's3']);
    expect(productionReadiness(cut).storyboard.shotLocks).toEqual({ s1: 'locked', s3: 'locked' });
    const { project: stretched } = applySceneUpdate(cut, 's1', { endSec: 6 });
    expect(productionReadiness(stretched).storyboard).toMatchObject({ approved: false, unlocked: ['s1'], shotLocks: { s1: 'changed', s3: 'locked' } });
  });

  it('unlocks only the merged shot when two shots are joined', () => {
    const { project: merged } = mergeNextScene(approvedBoard(), 's1');
    expect(productionReadiness(merged).storyboard.shotLocks).toEqual({ s1: 'changed', s3: 'locked' });
  });

  // Uniquely catches a lyric anchor dropped from a row slipping past the board check.
  it('still blocks the board on a storyboard row that drops its lyric anchor', () => {
    const board = approvedBoard();
    const rows = board.productionReview.draft.storyboard.map((shot) => shot.sceneId === 's1' ? { ...shot, lyricCueIds: [] } : shot);
    const unanchored = productionReadiness({ ...board, productionReview: { ...board.productionReview,
      draft: { ...board.productionReview.draft, storyboard: rows } } }).storyboard;
    expect(unanchored.approved).toBe(false);
    expect(unanchored.problems).toContain('Review lyric anchors for Verse.');
  });
});

describe('locking shots one at a time', () => {
  function artApproved() {
    const planned = project();
    const scenes = [planned.scenes[0], { ...planned.scenes[1], sceneId: 's2', label: 'Insert', endSec: 6 },
      { ...planned.scenes[1], sceneId: 's3', startSec: 6, endSec: 8 }];
    const draft = { ...planned.productionReview.draft, cast: 'The director', environments: 'Edit room', visualLanguage: 'Analog grain',
      motionLanguage: 'Slow push-ins', guideArtifactId: 'g1' };
    const ready = { ...planned, scenes, devArtifacts: [{ id: 'g1', mimeType: 'image/png', file: 'guide.png', version: 1 }],
      productionReview: { ...planned.productionReview, draft } };
    return approveProductionStage(ready, { stage: 'art', basis: productionReadiness(ready).basis.art });
  }

  // Uniquely catches a single shot's clip waiting on the whole storyboard approval.
  it('lets a locked shot make its clip before the board is approved', () => {
    const art = artApproved();
    expect(() => assertShotApproval(art, 's2')).toThrow(/Lock this shot/);
    const locked = setShotLocks(art, { sceneIds: ['s2'], locked: true });
    expect(() => assertShotApproval(locked, 's2')).not.toThrow();
    expect(() => assertShotApproval(locked, 's1')).toThrow(/Lock this shot/);
    expect(productionReadiness(locked).storyboard).toMatchObject({ approved: false, unlocked: ['s1', 's3'] });
    const all = setShotLocks(locked, { sceneIds: ['s1', 's3'], locked: true });
    expect(productionReadiness(all).storyboard).toMatchObject({ approved: true, unlocked: [] });
  });

  // Uniquely catches one shot's edit un-approving every other shot on an approved board.
  it('unlocks only the shot an edit touches, and the board until it is locked again', () => {
    const art = artApproved();
    const approved = approveProductionStage(art, { stage: 'storyboard', basis: productionReadiness(art).basis.storyboard });
    expect(productionReadiness(approved).storyboard.shotLocks).toEqual({ s1: 'locked', s2: 'locked', s3: 'locked' });
    const { project: edited } = applySceneUpdate(approved, 's2', { prompt: 'ASCII-art music video on the CRT' });
    const board = productionReadiness(edited).storyboard;
    expect(board.shotLocks).toEqual({ s1: 'locked', s2: 'changed', s3: 'locked' });
    expect(board).toMatchObject({ approved: false, unlocked: ['s2'] });
    expect(() => assertShotApproval(edited, 's1')).not.toThrow();
    expect(() => assertShotApproval(edited, 's2')).toThrow(/changed since you locked it/);
    // Picking another clip take is the shot's output, not an input: it stays locked.
    const { project: retaken } = applySceneUpdate(edited, 's1', { videoHistoryId: 'clip-2' });
    expect(productionReadiness(retaken).storyboard.shotLocks.s1).toBe('locked');
    const relocked = setShotLocks(retaken, { sceneIds: ['s2'], locked: true });
    expect(productionReadiness(relocked).storyboard.approved).toBe(true);
  });
});

describe('derived shot transitions', () => {
  it('takes the treatment entry and exit, else a plain cut, when the direction has no world', () => {
    const base = project();
    const photographic = { ...base, castAndSets: { status: 'approved', direction: { look: 'Analog film' } },
      scenes: [{ ...base.scenes[0], camera: { move: 'locked-off' }, direction: { transitionIn: 'match cut from the monitor glow', transitionOut: 'whip to the reel' } },
        { ...base.scenes[1], camera: { move: 'locked-off' } }] };
    const { storyboard } = productionReadiness(photographic);
    expect(storyboard.shots.map(s => s.transition)).toEqual(['Entry: match cut from the monitor glow. Exit: whip to the reel', 'Cut']);
    expect(storyboard.problems.filter(p => SHOT_PROBLEM.test(p))).toEqual([]);
  });
});
