import { describe, it, expect } from 'vitest';
import { diffLyricLines, songBaseline, remapSongTimeline, remapStoryboardShots } from './songRemap.js';

const cue = (id, text, startSec = null, endSec = null) => ({ id, text, startSec, endSec });

describe('diffLyricLines', () => {
  it('keeps ids for unchanged and reworded lines, mints ids for new lines and lists cut lines', () => {
    const before = [cue('a', 'Mountains rise'), cue('b', 'Oceans fall'), cue('c', 'We were small'), cue('d', 'Hello')];
    const after = [{ text: 'Mountains rise' }, { text: 'Oceans fall away' }, { text: 'A brand new verse' }, { text: 'Hello' }];
    const diff = diffLyricLines(before, after);
    expect(diff.cues.map((c) => c.id).slice(0, 2)).toEqual(['a', 'b']);
    expect(diff.cues[3].id).toBe('d');
    expect(diff.cueStatus).toMatchObject({ a: 'kept', b: 'changed', d: 'kept' });
    expect(diff.cueStatus[diff.cues[2].id]).toBe('added');
    expect(diff.changedFrom).toEqual({ b: 'Oceans fall' });
    expect(diff.removed.map((c) => c.id)).toEqual(['c']);
    expect(diff.counts).toEqual({ kept: 2, changed: 1, added: 1, removed: 1 });
  });

  it('matches a repeated chorus to its own occurrence', () => {
    const before = [cue('c1', 'At the scale'), cue('v', 'Old verse line'), cue('c2', 'At the scale')];
    const after = [{ text: 'At the scale' }, { text: 'At the scale' }];
    const diff = diffLyricLines(before, after);
    expect(diff.cues.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(diff.removed.map((c) => c.id)).toEqual(['v']);
  });
});

describe('remapSongTimeline', () => {
  // Old song: intro 0-10, line A 10-14, line B 14-18, instrumental 18-24, line C 24-28, cut line X 28-32, line D 32-36, end 40.
  const oldProject = {
    audioAnalysis: { durationSec: 40 },
    lyricCues: [cue('A', 'line a', 10, 14), cue('B', 'line b', 14, 18), cue('C', 'line c', 24, 28), cue('X', 'cut line', 28, 32), cue('D', 'line d', 32, 36)],
    scenes: [
      { sceneId: 'intro', startSec: 0, endSec: 10, lyricText: null },
      { sceneId: 'ab', startSec: 10, endSec: 18, lyricText: 'line a / line b' },
      { sceneId: 'break', startSec: 18, endSec: 24, lyricText: null },
      { sceneId: 'c', startSec: 24, endSec: 28, lyricText: 'line c' },
      { sceneId: 'x', startSec: 28, endSec: 32, lyricText: 'cut line' },
      { sceneId: 'd', startSec: 32, endSec: 40, lyricText: 'line d' },
    ],
  };

  it('carries shared lines across, carves inserted lines into new shots and flags cut and reworded shots', () => {
    const baseline = songBaseline(oldProject);
    // New song: everything 2 s later, a new two-line insert sung across the old break, line B reworded, line X cut.
    const diff = diffLyricLines(oldProject.lyricCues, [
      { text: 'line a' }, { text: 'line b changed' }, { text: 'new one' }, { text: 'new two' }, { text: 'line c' }, { text: 'line d' },
    ]);
    const times = [[12, 16], [16, 20], [20, 24], [24, 28], [34, 38], [38, 42]];
    const project = {
      audioAnalysis: { durationSec: 46 },
      lyricCues: diff.cues.map((c, i) => ({ ...c, startSec: times[i][0], endSec: times[i][1] })),
      scenes: oldProject.scenes,
    };
    const revision = { baseline, cueStatus: diff.cueStatus };
    const result = remapSongTimeline(project, revision);
    const byId = Object.fromEntries(result.scenes.map((s) => [s.sceneId, s]));
    expect(byId.intro).toMatchObject({ startSec: 0, endSec: 12 });
    expect(result.sceneReview.intro.status).toBe('kept');
    expect(byId.ab).toMatchObject({ startSec: 12, endSec: 20, lyricText: 'line a / line b changed' });
    expect(result.sceneReview.ab.status).toBe('changed');
    expect(byId.c).toMatchObject({ startSec: 34, endSec: 38 });
    expect(result.sceneReview.c.status).toBe('kept');
    expect(result.sceneReview.x).toMatchObject({ status: 'removed', previousLyricText: 'cut line' });
    expect(byId.x.endSec - byId.x.startSec).toBeLessThan(0.01);
    expect(byId.d).toMatchObject({ startSec: 38, endSec: 46 });
    // The break was stretched over the insert; the insert becomes its own shot ahead of it.
    expect(result.newScenes).toHaveLength(1);
    expect(result.newScenes[0]).toMatchObject({ lyricText: 'new one / new two', startSec: 20, endSec: 28 });
    expect(byId.break).toMatchObject({ startSec: 28, endSec: 34 });
    expect(result.sceneReview.break.status).toBe('kept');
    expect(result.counts).toEqual({ kept: 4, changed: 1, new: 1, removed: 1 });

    const storyboard = remapStoryboardShots([
      { id: 's1', sceneId: 'c', startSec: 24, endSec: 28, lyricCueIds: ['C'] },
      { id: 's2', sceneId: null, startSec: 0, endSec: 10, lyricCueIds: [] },
    ], { scenes: result.scenes, cues: project.lyricCues, map: result.map });
    expect(storyboard[0]).toMatchObject({ startSec: 34, endSec: 38, lyricCueIds: ['C'] });
    expect(storyboard[1]).toMatchObject({ startSec: 0, endSec: 12, lyricCueIds: [] });
  });

  it('rewrites a replaced verse into the shots that sang it instead of adding new ones', () => {
    const baseline = songBaseline(oldProject);
    const diff = diffLyricLines(oldProject.lyricCues, [
      { text: 'line a' }, { text: 'line b' }, { text: 'line c' }, { text: 'totally different words here' }, { text: 'line d' },
    ]);
    const times = [[10, 14], [14, 18], [24, 28], [28, 32], [32, 36]];
    const project = { audioAnalysis: { durationSec: 40 }, lyricCues: diff.cues.map((c, i) => ({ ...c, startSec: times[i][0], endSec: times[i][1] })), scenes: oldProject.scenes };
    const result = remapSongTimeline(project, { baseline, cueStatus: diff.cueStatus });
    expect(result.newScenes).toEqual([]);
    expect(result.sceneReview.x.status).toBe('changed');
    expect(result.scenes.find((s) => s.sceneId === 'x').lyricText).toBe('totally different words here');
  });
});
