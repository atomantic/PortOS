import { describe, it, expect } from 'vitest';
import { productionReadiness, productionAlignmentBasis, approveProductionStage, carryProductionApprovals } from './productionReview.js';
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

  // Uniquely catches cutting a shot and stretching its neighbour over the gap asking for a fresh storyboard approval.
  it('keeps the approval through a cut and a retime, and still stales on new content', () => {
    const cut = removeScene(approvedBoard(), 's2');
    expect(cut.productionReview.draft.storyboard.map((shot) => shot.sceneId)).toEqual(['s1', 's3']);
    expect(productionReadiness(cut).storyboard.problems).toContain('Storyboard shots must cover the master without unintended gaps or overlaps.');
    const { project: stretched } = applySceneUpdate(cut, 's1', { endSec: 6 });
    expect(productionReadiness(stretched).storyboard).toMatchObject({ approved: true, stale: null });
    const { project: relyriced } = applySceneUpdate(stretched, 's1', { lyricText: 'A new line' });
    expect(productionReadiness(relyriced).storyboard.approved).toBe(false);
  });

  // Uniquely catches rewording one approved shot (its prompt, or its storyboard row) un-approving the whole board.
  it('keeps the approval when a shot is reworded, and stales it when a shot is added', () => {
    const { project: reprompted } = applySceneUpdate(approvedBoard(), 's2', { visualIntent: 'ASCII-art music video on the CRT', prompt: 'Green ASCII frames' });
    const rows = reprompted.productionReview.draft.storyboard.map((shot) => shot.sceneId === 's2' ? { ...shot, action: 'ASCII-art video plays' } : shot);
    const reworded = { ...reprompted, productionReview: { ...reprompted.productionReview, draft: { ...reprompted.productionReview.draft, storyboard: rows } } };
    expect(productionReadiness(reworded).storyboard).toMatchObject({ approved: true, stale: null });
    const added = { ...reworded, scenes: [...reworded.scenes.map((scene) => scene.sceneId === 's3' ? { ...scene, endSec: 7 } : scene),
      { sceneId: 's4', label: 'Extra', startSec: 7, endSec: 8, visualIntent: 'A new shot', framePrompt: 'Wide shot' }] };
    const addedBoard = productionReadiness(added).storyboard;
    expect(addedBoard.problems).toEqual([]);
    expect(addedBoard.approved).toBe(false);
    expect(addedBoard.stale.changedFields).toContain('scene 4 timing');
  });

  it('keeps the approval when two shots are merged into one', () => {
    const { project: merged } = mergeNextScene(approvedBoard(), 's1');
    expect(productionReadiness(merged).storyboard).toMatchObject({ approved: true, stale: null });
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
