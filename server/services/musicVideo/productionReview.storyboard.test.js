import { describe, it, expect } from 'vitest';
import { anchorShotsToSungLyrics, dropStaleStoryboardRows, productionReadiness, productionAlignmentBasis, approveProductionStage, carryProductionApprovals, carryShotLocks, assertShotApproval, assertClipUnlocked, setShotLocks } from './productionReview.js';
import { addScenes, applySceneUpdate, mergeNextScene, removeScene, replaceScenes, splitScene } from './projectsLogic.js';

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
    const edited = { sceneId: 's1', lyricCueIds: ['c1'], action: 'She laughs', staging: '', camera: 'Close-up', transition: 'Cut' };
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
    expect(approved.productionReview.shotApprovals).toBeUndefined();
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

  it('keeps an approved storyboard current through a cut, retiming, and frame prompt change', () => {
    const cut = removeScene(approvedBoard(), 's2');
    expect(cut.productionReview.draft.storyboard.map((shot) => shot.sceneId)).toEqual(['s1', 's3']);
    expect(productionReadiness(cut).storyboard.shotLocks).toEqual({ s1: 'locked', s3: 'locked' });
    // Shot wording and timing may be refined without locking the reference frame.
    const { project: stretched } = applySceneUpdate(cut, 's1', { endSec: 6 });
    expect(productionReadiness(stretched).storyboard).toMatchObject({ approved: true, unlocked: [], shotLocks: { s1: 'locked', s3: 'locked' } });
    const { project: redrawn } = applySceneUpdate(stretched, 's1', { framePrompt: 'Close-up, desk lamp' });
    expect(productionReadiness(redrawn).storyboard).toMatchObject({ approved: true, unlocked: [] });
  });

  it('keeps the merged shot still locked when two shots are joined', () => {
    const { project: merged } = mergeNextScene(approvedBoard(), 's1');
    expect(productionReadiness(merged).storyboard.shotLocks).toEqual({ s1: 'locked', s3: 'locked' });
  });

  // Uniquely catches new shots staling the whole-board approval that was all that locked the old ones.
  it('keeps the approved shots locked when the planner adds shots, and leaves the new ones open', () => {
    const board = approvedBoard();
    const { project: added, scenes: [fresh] } = addScenes(board, [{ label: 'Tag', startSec: 8, endSec: 9, visualIntent: 'Lights out', framePrompt: 'Black' }]);
    expect(productionReadiness(carryShotLocks(board, added)).storyboard.shotLocks)
      .toEqual({ s1: 'locked', s2: 'locked', s3: 'locked', [fresh.sceneId]: 'open' });
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

  it('keeps the board approved while shot prompts and clip selections change', () => {
    const art = artApproved();
    const approved = approveProductionStage(art, { stage: 'storyboard', basis: productionReadiness(art).basis.storyboard });
    expect(productionReadiness(approved).storyboard.shotLocks).toEqual({ s1: 'locked', s2: 'locked', s3: 'locked' });
    // Marking a clip as code-rendered only relabels it on the board: the board stays approved.
    const coded = applySceneUpdate(approved, 's3', { codeClip: true }).project;
    expect(productionReadiness(coded).storyboard.approved).toBe(true);
    // The mark belongs to the clip it was set on: choosing another clip drops it.
    expect(applySceneUpdate(coded, 's3', { videoHistoryId: 'ai-clip' }).updated.codeClip).toBeUndefined();
    expect(applySceneUpdate(coded, 's3', { prompt: 'Same clip, new words' }).updated.codeClip).toBe(true);
    const { project: edited } = applySceneUpdate(approved, 's2', { prompt: 'ASCII-art music video on the CRT' });
    const board = productionReadiness(edited).storyboard;
    expect(board).toMatchObject({ approved: true, unlocked: [] });
    expect(edited.productionReview.shotApprovals).toBeUndefined();
    // Picking another clip take is the shot's output, not a board revision.
    const { project: retaken } = applySceneUpdate(edited, 's1', { videoHistoryId: 'clip-2' });
    expect(productionReadiness(retaken).storyboard.approved).toBe(true);
  });

  // Uniquely catches a board approved before per-shot locks shipped dropping to "N shots not locked"
  // the moment one shot is locked or unlocked.
  it('keeps an earlier whole-board approval as a lock on every shot it covers', () => {
    const art = artApproved();
    const approved = approveProductionStage(art, { stage: 'storyboard', basis: productionReadiness(art).basis.storyboard });
    const { shotApprovals: _none, ...review } = approved.productionReview;
    const legacy = { ...approved, productionReview: review };
    expect(productionReadiness(legacy).storyboard).toMatchObject({ approved: true, unlocked: [] });
    // The shape already saved by the first release: one shot locked on top of the old approval.
    const s2 = setShotLocks(legacy, { sceneIds: ['s2'], locked: true }).productionReview.shotApprovals.s2;
    expect(productionReadiness({ ...legacy, productionReview: { ...review, shotApprovals: { s2 } } }).storyboard)
      .toMatchObject({ approved: true, unlocked: [] });
    // Locking now carries the approval onto every shot, so it outlives the approval going stale.
    expect(Object.keys(setShotLocks(legacy, { sceneIds: ['s2'], locked: true }).productionReview.shotApprovals)).toEqual(['s1', 's2', 's3']);
    const unlocked = setShotLocks(legacy, { sceneIds: ['s2'], locked: false });
    expect(productionReadiness(unlocked).storyboard).toMatchObject({ approved: false, unlocked: ['s2'] });
    expect(() => assertShotApproval(unlocked, 's1')).not.toThrow();
  });

  // Uniquely catches unlocking every shot falling back to the old whole-board approval.
  it('leaves the board unapproved after every shot of an approved board is unlocked', () => {
    const art = artApproved();
    const approved = approveProductionStage(art, { stage: 'storyboard', basis: productionReadiness(art).basis.storyboard });
    const open = setShotLocks(approved, { sceneIds: ['s1', 's2', 's3'], locked: false });
    expect(productionReadiness(open).storyboard.approved).toBe(false);
    expect(() => assertShotApproval(open, 's1')).toThrow(/Lock this shot/);
  });

  // Uniquely catches a video shot locking in one step, or a still/card shot asking for a video lock.
  it('locks a video shot still first, then its clip, and a card shot once', () => {
    const art = artApproved();
    const composed = { ...art, composition: { mode: 'composed' }, scenes: art.scenes.map(s => s.sceneId === 's3' ? { ...s, visualLayer: 'card' } : s) };
    const still = setShotLocks(composed, { sceneIds: ['s2', 's3'], locked: true });
    expect(productionReadiness(still).storyboard).toMatchObject({ clipLocks: { s1: 'open', s2: 'open', s3: null }, clipsUnlocked: ['s1', 's2'] });
    expect(() => setShotLocks(still, { sceneIds: ['s2'], locked: true, stage: 'video' })).toThrow(/choose this shot's clip/);
    expect(() => setShotLocks(still, { sceneIds: ['s3'], locked: true, stage: 'video' })).toThrow(/no video/);
    expect(() => setShotLocks(composed, { sceneIds: ['s1'], locked: true, stage: 'video' })).toThrow(/still before its video/);
    const { project: rendered } = applySceneUpdate(still, 's2', { videoHistoryId: 'clip-1' });
    const video = setShotLocks(rendered, { sceneIds: ['s2'], locked: true, stage: 'video' });
    expect(productionReadiness(video).storyboard).toMatchObject({ clipLocks: { s2: 'locked' }, clipsUnlocked: ['s1'] });
    expect(() => assertClipUnlocked(video, 's2', { prompt: 'New motion' })).toThrow(/video is locked/);
    expect(() => assertClipUnlocked(video, 's2', { photoSequence: { imageIds: ['photo.png'], intervalFrames: 6 } })).toThrow(/video is locked/);
    expect(() => assertClipUnlocked(video, 's2', { textZone: 'upper' })).not.toThrow();
    expect(() => assertClipUnlocked(video, 's1')).not.toThrow();
    // Unlocking the still takes the clip lock with it.
    const reopened = setShotLocks(video, { sceneIds: ['s2'], locked: false });
    expect(productionReadiness(reopened).storyboard.clipLocks.s2).toBe('open');
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

describe('lyric anchors follow the singing', () => {
  // The line window opens at 3.5 (where the line before ended); its first word is sung at 5.
  const cue = { id: 'c2', text: 'if you think this is slop', startSec: 3.5, endSec: 7, words: [{ w: 'if', startSec: 5, endSec: 5.4 }, { w: 'slop', startSec: 6, endSec: 6.8 }] };
  function board(shots) {
    const base = project({ draftShots: shots });
    return { ...base, lyricCues: [...base.lyricCues, cue], scenes: [base.scenes[0], { ...base.scenes[1], startSec: 4, endSec: 4.9, sceneId: 's2', label: 'Drummer' },
      { ...base.scenes[1], sceneId: 's3', label: 'Singer', startSec: 4.9, endSec: 8 }] };
  }
  const row = (sceneId, lyricCueIds) => ({ sceneId, lyricCueIds, action: 'a', staging: 'b', camera: 'c', transition: 'Cut' });

  // Uniquely catches a shot in the instrumental gap before a line being held to that line's anchor.
  it('anchors a line to the shots its words are sung over, not the gap before them, and names what to fix', () => {
    const stale = board([row('s1', ['c1']), row('s2', ['c2']), row('s3', [])]);
    const { storyboard } = productionReadiness(stale);
    expect(storyboard.problems.filter((p) => ANCHOR_PROBLEM.test(p))).toEqual(['Review lyric anchors for Singer.']);
    expect(storyboard.lyricAnchors).toEqual([{ sceneId: 's3', sung: ['if you think this is slop'], anchored: [] }]);
    const fixed = anchorShotsToSungLyrics(stale, ['s3']);
    expect(fixed.productionReview.draft.storyboard.find((shot) => shot.sceneId === 's3').lyricCueIds).toEqual(['c2']);
    expect(productionReadiness(fixed).storyboard.lyricAnchors).toEqual([]);
  });

  // Uniquely catches a retimed shot keeping the lyric and anchor of the span it left.
  it('moves the lyric and its anchor with a retimed shot', () => {
    const swapped = board([row('s1', ['c1']), row('s2', []), row('s3', ['c2'])]);
    const { project: next } = applySceneUpdate(swapped, 's2', { endSec: 6 });
    expect(next.scenes.find((scene) => scene.sceneId === 's2').lyricText).toBe('if you think this is slop');
    expect(next.productionReview.draft.storyboard.find((shot) => shot.sceneId === 's2').lyricCueIds).toEqual(['c2']);
    const { project: back } = applySceneUpdate(next, 's2', { endSec: 4.9 });
    expect(back.scenes.find((scene) => scene.sceneId === 's2').lyricText).toBeNull();
    expect(back.productionReview.draft.storyboard.find((shot) => shot.sceneId === 's2').lyricCueIds).toEqual([]);
  });
});

describe('storyboard rows stay bound to the shots on the board', () => {
  const row = (sceneId, extra = {}) => ({ sceneId, lyricCueIds: [], action: 'Reels spin', staging: 'Wide', camera: 'Locked off', transition: 'Cut', ...extra });

  // Uniquely catches a row left from a cut shot holding the board until someone binds it to a shot that no longer exists.
  it('names rows left from deleted shots and removes them in one go, keeping unbound rows to bind', () => {
    const left = project({ draftShots: [row('s1', { lyricCueIds: ['c1'] }), row('gone', { startSec: 2, endSec: 3.5, action: 'Skid across the floor' }), { ...row(null), id: 'draft-9' }] });
    const { storyboard } = productionReadiness(left);
    expect(storyboard.staleRows).toEqual([{ id: null, sceneId: 'gone', startSec: 2, endSec: 3.5, action: 'Skid across the floor' }]);
    expect(storyboard.problems).toContain('Remove 1 storyboard row left from deleted shots.');
    expect(storyboard.problems).toContain('Bind every draft shot to a real Board scene.');
    const cleaned = dropStaleStoryboardRows(left);
    expect(cleaned.productionReview.draft.storyboard.map((shot) => shot.sceneId)).toEqual(['s1', null]);
    expect(productionReadiness(cleaned).storyboard.staleRows).toEqual([]);
    expect(dropStaleStoryboardRows(cleaned)).toBe(cleaned);
  });

  // Uniquely catches a split leaving its row on the whole old span while the new piece has none.
  it('splits the row with the shot: each piece keeps the direction, anchored to its own lines', () => {
    const board = project({ draftShots: [row('s1', { id: 'r1', startSec: 0, endSec: 4, lyricCueIds: ['c1'] }), row('s2')] });
    const { project: split, scenes: [first, second] } = splitScene(board, 's1', { atSec: 2.5 });
    const rows = split.productionReview.draft.storyboard;
    expect(rows.map((shot) => shot.sceneId)).toEqual([first.sceneId, second.sceneId, 's2']);
    expect(rows[0]).toMatchObject({ id: 'r1', startSec: 0, endSec: 2.5, lyricCueIds: ['c1'], action: 'Reels spin' });
    expect(rows[1]).toMatchObject({ id: `shot-${second.sceneId}`, startSec: 2.5, endSec: 4, lyricCueIds: [], action: 'Reels spin' });
    const { storyboard } = productionReadiness(split);
    expect(storyboard.staleRows).toEqual([]);
    expect(storyboard.problems.filter((p) => ANCHOR_PROBLEM.test(p))).toEqual([]);
  });

  it('drops the rows of shots a re-plan replaces', () => {
    const board = project({ draftShots: [row('s1'), row('s2')] });
    const { project: replanned } = replaceScenes(board, [{ label: 'Verse', startSec: 0, endSec: 4 }, { label: 'New', startSec: 4, endSec: 6, visualIntent: 'x' }, { label: 'Tag', startSec: 6, endSec: 8, visualIntent: 'y' }]);
    expect(replanned.productionReview.draft.storyboard.map((shot) => shot.sceneId)).toEqual(['s1']);
  });
});

describe('naming the shots behind Shot coverage and Shot details', () => {
  // Uniquely catches a cutaway with no camera note blocking the board it was locked on.
  it('lets a Board shot leave its camera blank', () => {
    const planned = project({ draftShots: [{ sceneId: 's1', lyricCueIds: ['c1'], action: 'She looks up', staging: 'Desk', camera: '', transition: 'Cut' }] });
    const bare = { ...planned, castAndSets: { status: 'approved', direction: { world: {} } } };
    const { storyboard } = productionReadiness(bare);
    expect(storyboard.incompleteShots).toEqual([]);
    expect(storyboard.problems.filter((p) => SHOT_PROBLEM.test(p))).toEqual([]);
  });

  // Uniquely catches the coverage and details checks failing a board without saying which shot to fix.
  it('names the shot at each gap, overlap and song-end mismatch, and what each incomplete shot is missing', () => {
    const base = project();
    const scenes = [{ ...base.scenes[0], endSec: 3 }, { ...base.scenes[1], sceneId: 's2', label: 'Insert', startSec: 3.5, endSec: 5 },
      { ...base.scenes[1], sceneId: 's3', label: 'Outro', startSec: 4.8, endSec: 8.5, visualIntent: '' }];
    const { storyboard } = productionReadiness({ ...base, scenes });
    expect(storyboard.coverage).toEqual([
      { sceneId: 's2', issue: 'gap', startSec: 3, endSec: 3.5 },
      { sceneId: 's3', issue: 'overlap', startSec: 4.8, endSec: 5 },
      { sceneId: 's3', issue: 'past-end', startSec: 8, endSec: 8.5 },
    ]);
    expect(storyboard.incompleteShots).toEqual([{ sceneId: 's3', missing: ['an end inside the song', 'action'] }]);
    expect(productionReadiness(base).storyboard).toMatchObject({ coverage: [], incompleteShots: [] });
  });
});
