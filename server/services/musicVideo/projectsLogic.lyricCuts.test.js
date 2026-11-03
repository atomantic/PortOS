import { describe, it, expect } from 'vitest';
import { buildProjectRecord, applyProjectPatch, addScenes, applySceneUpdate, cutScenesOnLyricWords } from './projectsLogic.js';

// Four lines of a roll call, each word 0.9 s apart; "Great Danoodle," is one phrase.
const LINES = [
  ['l1', 'Great Danoodle, Beagle, Pug!', 10],
  ['l2', 'Corgi, Collie, Shih Tzu,', 14],
  ['l3', 'Poodle, Boxer, Husky', 18],
  ['l4', 'Akita and Malamute', 22],
];
const cue = ([id, text, at], shift = {}) => {
  const words = text.split(' ').map((w, i) => {
    const startSec = Math.round((at + i * 0.9 + (shift[`${id}:${i}`] || 0)) * 1000) / 1000;
    return { w, startSec, endSec: Math.round((startSec + 0.5) * 1000) / 1000, conf: 'matched' };
  });
  return { id, text, startSec: words[0].startSec, endSec: words.at(-1).endSec, words };
};

function project() {
  const base = applyProjectPatch(buildProjectRecord({ name: 'Roll call' }, { id: 'mv-1', now: '2026-01-01T00:00:00.000Z' }),
    { lyricCues: LINES.map((line) => cue(line)) });
  return addScenes(base, [
    { label: 'Intro', startSec: 0, endSec: 10.05 },
    { label: 'Verse', startSec: 10.05, endSec: 26 },
    { label: 'Outro', startSec: 26, endSec: 30 },
  ]).project;
}

describe('cutScenesOnLyricWords', () => {
  // Catches cuts placed off the word onsets, a comma phrase split in two, or a cut near an existing boundary doubling it.
  it('makes one shot per comma phrase over the chosen lines, each starting on its first word', () => {
    const { project: next, scenes, skipped } = cutScenesOnLyricWords(project(), { cueIds: ['l1', 'l2', 'l3', 'l4'], mode: 'phrase' });
    expect(skipped).toBe(0);
    expect(scenes.map((s) => s.lyricText)).toEqual(['Great Danoodle,', 'Beagle,', 'Pug!', 'Corgi,', 'Collie,', 'Shih Tzu,', 'Poodle,', 'Boxer,', 'Husky', 'Akita and Malamute']);
    const onsets = [10, 11.8, 12.7, 14, 14.9, 15.8, 18, 18.9, 19.8, 22];
    scenes.forEach((s, i) => expect(Math.abs(s.startSec - onsets[i])).toBeLessThan(1 / 48));
    expect(scenes[0].lyricAnchor).toEqual({ cueId: 'l1', wordIndex: 0, wordCount: 2 });
    expect(scenes[5].lyricAnchor).toEqual({ cueId: 'l2', wordIndex: 2, wordCount: 2 });
    // The verse's own start moved onto the first word; the intro ends there; the board stays contiguous.
    const board = next.scenes.slice().sort((a, b) => a.startSec - b.startSec);
    expect(board.map((s) => s.label)).toContain('Intro');
    board.slice(1).forEach((s, i) => expect(s.startSec).toBeCloseTo(board[i].endSec, 6));
    expect(board.at(-1).label).toBe('Outro');
  });

  it('cuts per word, and refuses lines that have no word timing', () => {
    const { scenes } = cutScenesOnLyricWords(project(), { cueIds: ['l4'], mode: 'word' });
    expect(scenes.map((s) => s.lyricText)).toEqual(['Akita', 'and', 'Malamute']);
    const untimed = applyProjectPatch(project(), { lyricCues: [{ id: 'l1', text: 'Great Danoodle, Beagle, Pug!', startSec: 10, endSec: 13 }] });
    expect(() => cutScenesOnLyricWords(untimed, { cueIds: ['l1'], mode: 'phrase' })).toThrow(/Align the lyric words first/);
  });
});

describe('word-anchored shots after re-alignment', () => {
  // Catches anchors left on stale times, a predecessor that gaps or overlaps, or unanchored shots being moved.
  it('moves each anchored shot with its word and ends the shot before it there', () => {
    const cut = cutScenesOnLyricWords(project(), { cueIds: ['l1', 'l2'], mode: 'phrase' }).project;
    const before = new Map(cut.scenes.map((s) => [s.sceneId, s]));
    const beagle = cut.scenes.find((s) => s.lyricText === 'Beagle,');
    const great = cut.scenes.find((s) => s.lyricText === 'Great Danoodle,');
    const realigned = applyProjectPatch(cut, { lyricCues: LINES.map((line) => cue(line, { 'l1:2': 0.2 })) });
    const moved = realigned.scenes.find((s) => s.sceneId === beagle.sceneId);
    expect(moved.startSec).toBeCloseTo(beagle.startSec + 0.2, 6);
    expect(realigned.scenes.find((s) => s.sceneId === great.sceneId).endSec).toBeCloseTo(moved.startSec, 6);
    expect(realigned.lyricAnchorSync.moved).toEqual([{ sceneId: beagle.sceneId, fromSec: beagle.startSec, toSec: moved.startSec }]);
    for (const scene of realigned.scenes) {
      if ([beagle.sceneId, great.sceneId].includes(scene.sceneId)) continue;
      expect([scene.startSec, scene.endSec]).toEqual([before.get(scene.sceneId).startSec, before.get(scene.sceneId).endSec]);
    }
  });

  it('lists a shot whose word lost its timing, and drops the anchor when the shot is retimed by hand', () => {
    const cut = cutScenesOnLyricWords(project(), { cueIds: ['l2'], mode: 'phrase' }).project;
    const collie = cut.scenes.find((s) => s.lyricText === 'Collie,');
    const edited = applyProjectPatch(cut, { lyricCues: [cue(LINES[0]), { id: 'l2', text: 'Corgi, Collie, Shih Tzu, Spitz', startSec: 14, endSec: 18 }, ...LINES.slice(2).map((line) => cue(line))] });
    expect(edited.lyricAnchorSync.unresolved).toContain(collie.sceneId);
    expect(edited.scenes.find((s) => s.sceneId === collie.sceneId).startSec).toBe(collie.startSec);
    const retimed = applySceneUpdate(cut, collie.sceneId, { startSec: collie.startSec + 0.3 }).updated;
    expect(retimed).not.toHaveProperty('lyricAnchor');
  });
});

describe('word anchors in documents and the storyboard check', () => {
  // Catches a composition losing the anchor or reading a stale onset, and an off-word shot passing the check.
  it('gives PORTOS_MV scenes the anchor and its current onset, and names a shot that left its word', async () => {
    const { buildDocumentData } = await import('./documentRender.js');
    const { productionReadiness } = await import('./productionReview.js');
    const cut = cutScenesOnLyricWords(project(), { cueIds: ['l1'], mode: 'phrase' }).project;
    const realigned = { ...cut, lyricCues: LINES.map((line) => cue(line, { 'l1:2': 0.2 })) };
    const data = buildDocumentData(realigned, { frame: { width: 96, height: 64 }, clock: { fps: 24, frames: 720, durationSec: 30 }, songDurationSec: 30 });
    const beagle = data.scenes.find((s) => s.lyricText === 'Beagle,');
    expect(beagle.lyricAnchor).toEqual({ cueId: 'l1', wordIndex: 2, wordCount: 1, onsetSec: 12, text: 'Beagle,' });
    expect(data.scenes.find((s) => s.label === 'Outro')).not.toHaveProperty('lyricAnchor');
    const problems = productionReadiness({ ...realigned, productionReview: { draft: { lyricsMode: 'vocal', timingStatus: 'verified', storyboard: [] } } }).storyboard.problems;
    expect(problems.some((p) => /starts at 11\.80s, but "Beagle," is sung at 12\.00s/.test(p))).toBe(true);
  });
});
