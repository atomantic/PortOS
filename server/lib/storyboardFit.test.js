import { describe, expect, it } from 'vitest';
import { fitStoryboardToSong, storyboardFitSong, storyboardShotPanel } from './storyboardFit.js';

const panel = (id, seconds, action = `Panel ${id}`) => ({ id: `panel-${id}`, action, dialogue: '', framing: null, camera: '', seconds, castIds: [], environmentIds: [], objectIds: [] });
const beat = (id, musicalRole, panels, extra = {}) => ({ id: `beat-${id}`, title: '', what: '', musicalRole, panels, ...extra });
const song = (extra = {}) => storyboardFitSong({
  audioAnalysis: {
    durationSec: 60, beats: [], downbeats: [],
    sections: [{ label: 'Intro', startSec: 0, endSec: 8 }, { label: 'Verse 1', startSec: 8, endSec: 30 }, { label: 'Chorus 1', startSec: 30, endSec: 60 }],
    ...extra,
  },
  lyricCues: [{ id: 'c1', text: 'First line', startSec: 9 }, { id: 'c2', text: 'Hook line', startSec: 31 }],
});
const board = {
  beats: [
    beat('a', 'intro', [panel('a1', 3)]),
    beat('b', 'verse', [panel('b1', 3), panel('b2', 3)]),
    beat('c', 'chorus', [panel('c1', 6)]),
  ],
};

describe('fitStoryboardToSong', () => {
  it('places beats on the nearest section starts and splits panels by their holds', () => {
    const fit = fitStoryboardToSong(board, song());
    expect(fit.beats.map((b) => [b.startSec, b.endSec, b.sectionLabel, b.snap])).toEqual([
      [0, 8, 'Intro', 'start'], [8, 30, 'Verse 1', 'section'], [30, 60, 'Chorus 1', 'section'],
    ]);
    expect(fit.beats[2]).toMatchObject({ boardSec: 6, songSec: 30 });
    expect(fit.shots.map((s) => [s.panelId, s.startSec, s.endSec, s.label, s.sectionIndex])).toEqual([
      ['panel-a1', 0, 8, 'Intro', 0], ['panel-b1', 8, 19, 'Verse · 1/2', 1], ['panel-b2', 19, 30, 'Verse · 2/2', 1], ['panel-c1', 30, 60, 'Chorus', 2],
    ]);
    // The chorus can start on the hook line instead; a pick that runs time backwards is ignored.
    expect(fit.beats[2].options).toContainEqual({ at: 31, kind: 'lyric', label: 'Hook line' });
    const picked = fitStoryboardToSong(board, song(), { starts: { 'beat-c': 31 } });
    expect(picked.beats.map((b) => [b.startSec, b.snap])).toEqual([[0, 'start'], [8, 'section'], [31, 'picked']]);
    const backwards = fitStoryboardToSong(board, song(), { starts: { 'beat-c': 5 } });
    expect(backwards.beats[2]).toMatchObject({ startSec: 30, snap: 'section' });
  });

  it('cuts panels on the beat grid and prefers a section matching the beat role', () => {
    const fit = fitStoryboardToSong(board, song({ beats: [18.8, 19.4], sections: [
      { label: 'Intro', startSec: 0, endSec: 10 }, { label: 'Section 2', startSec: 10, endSec: 32 }, { label: 'Chorus', startSec: 32, endSec: 60 },
    ] }));
    // The chorus beat lands on the section named Chorus.
    expect(fit.beats.map((b) => b.startSec)).toEqual([0, 10, 32]);
    expect(fit.shots[1]).toMatchObject({ startSec: 10, endSec: 21 });
    const gridded = fitStoryboardToSong({ beats: [beat('x', null, [panel('x1', 1), panel('x2', 1)])] }, song({ beats: [29.8] }));
    expect(gridded.shots.map((s) => [s.startSec, s.endSec])).toEqual([[0, 29.8], [29.8, 60]]);
  });

  it('keeps a beat with no panels as one shot from its words, leaves every shot its minimum, and names short ones', () => {
    const fit = fitStoryboardToSong({
      beats: [beat('a', null, [panel('a1', 50)]), beat('b', null, [], { title: 'Gap', what: 'The street empties' }), beat('c', null, Array.from({ length: 6 }, (_, i) => panel(`c${i}`, 1)))],
    }, storyboardFitSong({ audioAnalysis: { durationSec: 40, sections: [], beats: [], downbeats: [] } }));
    expect(fit.beats[1]).toMatchObject({ title: 'Gap', noPanels: true, shots: 1 });
    expect(fit.shots.find((s) => s.beatId === 'beat-b')).toMatchObject({ panelId: null, panelRev: null, visualIntent: 'The street empties' });
    // The long first beat would leave the last six panels under a second each; they keep two.
    expect(fit.shots.slice(-6).every((s) => s.endSec - s.startSec >= 2)).toBe(true);
    expect(fit.beats.map((b) => b.short)).toEqual([0, 0, 0]);
    expect(fit.shots.at(-1).endSec).toBe(40);
    const cramped = fitStoryboardToSong({ beats: [beat('c', null, Array.from({ length: 6 }, (_, i) => panel(`c${i}`, 1)))] },
      storyboardFitSong({ audioAnalysis: { durationSec: 9, sections: [], beats: [], downbeats: [] } }));
    expect(cramped.beats[0].short).toBe(6);
  });

  it('fingerprints what a shot drew from its panel, not its length', () => {
    const rev = (p) => fitStoryboardToSong({ beats: [beat('a', null, [p])] }, song()).shots[0].panelRev;
    expect(rev(panel('a1', 3))).toBe(rev(panel('a1', 9)));
    expect(rev(panel('a1', 3))).not.toBe(rev(panel('a1', 3, 'Something else')));
  });

  it.each([
    { holds: [[3], [3], [3]], durationSec: 3 },
    { holds: [[1], [1, 1], [1, 1, 1]], durationSec: 0.059 },
    { holds: [[3], [], [1, 1]], durationSec: 1 },
    { holds: [[40, 0.001, 40]], durationSec: 40, grid: [20.2] },
  ])('keeps every cut positive and within a cramped song ($durationSec s)', ({ holds, durationSec, grid = [] }) => {
    const cramped = { beats: holds.map((values, b) => beat(String(b), null, values.map((seconds, p) => panel(`${b}-${p}`, seconds)))) };
    const fit = fitStoryboardToSong(cramped, storyboardFitSong({ audioAnalysis: { durationSec, sections: [], beats: grid, downbeats: [] } }));
    expect(fit.shots).toHaveLength(holds.reduce((sum, values) => sum + Math.max(1, values.length), 0));
    expect(fit.shots[0].startSec).toBe(0);
    expect(fit.shots.at(-1).endSec).toBe(durationSec);
    fit.shots.forEach((shot, i) => {
      expect(shot.startSec).toBeGreaterThanOrEqual(0);
      expect(shot.endSec).toBeGreaterThan(shot.startSec);
      expect(shot.endSec).toBeLessThanOrEqual(durationSec);
      if (i > 0) expect(shot.startSec).toBe(fit.shots[i - 1].endSec);
    });
    expect(fit.beats.reduce((sum, b) => sum + b.short, 0)).toBe(fit.shots.filter((s) => s.endSec - s.startSec < 2 - 0.001).length);
  });

  it('reads a fitted shot\'s panel as current, changed or missing', () => {
    const shot = fitStoryboardToSong(board, song()).shots[1];
    expect(storyboardShotPanel(board, shot)).toMatchObject({ state: 'current', number: 2, beatIndex: 1 });
    const edited = { beats: board.beats.map((b) => ({ ...b, panels: b.panels.map((p) => (p.id === 'panel-b1' ? { ...p, action: 'New' } : p)) })) };
    expect(storyboardShotPanel(edited, shot).state).toBe('changed');
    expect(storyboardShotPanel({ beats: [] }, shot).state).toBe('missing');
    // New panel art reads as changed too, since the art is the shot's frame reference.
    const art = { beats: board.beats.map((b) => ({ ...b, panels: b.panels.map((p) => (p.id === 'panel-b1'
      ? { ...p, takes: [{ id: 'take-1', source: 'gallery', image: 'b1.png' }], selectedTakeId: 'take-1' } : p)) })) };
    expect(storyboardShotPanel(art, shot)).toMatchObject({ state: 'changed', artChanged: true });
    expect(storyboardShotPanel(art, fitStoryboardToSong(art, song()).shots[1])).toMatchObject({ state: 'current', artChanged: false });
    expect(storyboardShotPanel(board, { sceneId: 'mvs-hand' })).toBeNull();
  });

  // Uniquely catches the board's song sections following the audio detector's boundaries instead of the lyric sheet.
  it('takes the song sections from the timed lyric sheet, with Intro and Outro for the unsung ends', () => {
    const project = {
      audioAnalysis: { durationSec: 60, sections: [{ label: 'A', startSec: 0, endSec: 30 }, { label: 'B', startSec: 30, endSec: 60 }] },
      lyricCues: [
        { text: 'first verse line', startSec: 8, endSec: 12 },
        { text: 'second verse line', startSec: 14, endSec: 20 },
        { text: 'chorus line', startSec: 24, endSec: 30 },
        { text: 'last chorus line', startSec: 33, endSec: 50 },
      ],
      lyricMarkers: [
        { type: 'section', label: 'Verse 1', kind: 'verse', line: 0 },
        { type: 'section', label: 'Chorus', kind: 'chorus', line: 2 },
      ],
    };
    expect(storyboardFitSong(project).sections).toEqual([
      { label: 'Intro', startSec: 0, endSec: 8 },
      { label: 'Verse 1', startSec: 8, endSec: 24 },
      { label: 'Chorus', startSec: 24, endSec: 50 },
      { label: 'Outro', startSec: 50, endSec: 60 },
    ]);
    // An untimed sheet keeps the analysis sections.
    const untimed = { ...project, lyricCues: project.lyricCues.map(({ text }) => ({ text })) };
    expect(storyboardFitSong(untimed).sections.map((section) => section.label)).toEqual(['A', 'B']);
  });

  it('needs an analyzed song', () => {
    expect(storyboardFitSong({})).toBeNull();
    expect(fitStoryboardToSong(board, null)).toEqual({ beats: [], shots: [] });
  });
});
