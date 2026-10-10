import { describe, it, expect } from 'vitest';
import { productionReadiness, productionAlignmentBasis } from './productionReview.js';

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
