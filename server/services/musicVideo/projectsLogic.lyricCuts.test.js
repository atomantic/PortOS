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
    // A hand retime while the word is untimed also wins over the next alignment.
    const whileUntimed = applySceneUpdate(edited, collie.sceneId, { startSec: collie.startSec + 0.3 }).project;
    const back = applyProjectPatch(whileUntimed, { lyricCues: LINES.map((line) => cue(line)) });
    expect(back.scenes.find((s) => s.sceneId === collie.sceneId).startSec).toBeCloseTo(collie.startSec + 0.3, 6);
  });

  // Catches a move accepted against a neighbour's move that is itself blocked, leaving a negative-length shot.
  it('blocks moves that depend on a neighbour that cannot move, keeping every span positive and contiguous', () => {
    const base = addScenes(applyProjectPatch(buildProjectRecord({ name: 'Two words' }, { id: 'mv-2', now: 'n' }),
      { lyricCues: [cue(['a', 'one, two', 10], {}), cue(['b', 'three', 30])] }), [
      { label: 'Intro', startSec: 0, endSec: 10 },
      { label: 'Words', startSec: 10, endSec: 12 },
      { label: 'Outro', startSec: 12, endSec: 20 },
    ]).project;
    // Shift the words so "one," lands at 10 and "two" at 10.9, then cut there.
    const cut = cutScenesOnLyricWords(base, { cueIds: ['a'], mode: 'phrase' }).project;
    const words = cut.scenes.filter((s) => s.lyricAnchor);
    expect(words).toHaveLength(2);
    // "two" moves past the outro's fixed start, so it cannot move, and "one," may not move past it either.
    const realigned = applyProjectPatch(cut, { lyricCues: [cue(['a', 'one, two', 10], { 'a:0': 1.5, 'a:1': 1.2 }), cue(['b', 'three', 30])] });
    const board = realigned.scenes.slice().sort((x, y) => x.startSec - y.startSec);
    board.forEach((s) => expect(s.endSec - s.startSec).toBeGreaterThan(0));
    board.slice(1).forEach((s, i) => expect(s.startSec).toBeCloseTo(board[i].endSec, 6));
    expect(realigned.lyricAnchorSync.blocked.sort()).toEqual(words.map((s) => s.sceneId).sort());
  });
});

describe('word cuts in the render plan', () => {
  const durations = (clips) => clips.map((c) => Math.round(c.duration * 1000) / 1000);
  const render = async (project) => {
    const { beatSnapClips } = await import('./render.js');
    const { wordTimedScenes } = await import('../../lib/musicVideoLayers.js');
    const scenes = wordTimedScenes(project, project.scenes.slice().sort((a, b) => a.startSec - b.startSec));
    return durations(beatSnapClips(scenes.map((s) => ({ sceneId: s.sceneId, inSec: 0, outSec: 5, duration: 5 })), [], { scenes }));
  };
  const board = (spans, words) => addScenes(applyProjectPatch(buildProjectRecord({ name: 'Fast' }, { id: 'mv-3', now: 'n' }),
    { lyricCues: [{ id: 'f', text: words.map(() => 'go').join(' '), startSec: words[0], endSec: words.at(-1) + 0.1,
      words: words.map((startSec) => ({ w: 'go', startSec, endSec: startSec + 0.1, conf: 'matched' })) }] }),
  spans.map(([startSec, endSec], i) => ({ label: `Shot ${i + 1}`, startSec, endSec }))).project;

  // Catches the render laying later word shots after earlier shots' natural clip lengths, or flooring a short word shot.
  it('plays every shot of a word-cut board for exactly its saved span', async () => {
    const short = cutScenesOnLyricWords(board([[0, 2]], [0.2, 0.4, 0.7]), { cueIds: ['f'], mode: 'word' }).project;
    expect(await render(short)).toEqual([0.2, 0.2, 0.3, 1.3]);
    const later = cutScenesOnLyricWords(board([[0, 2], [2, 10], [10, 12], [12, 14]], [10, 11]), { cueIds: ['f'], mode: 'word' }).project;
    expect(await render(later)).toEqual([2, 8, 1, 1, 2]);
  });

  // Catches a manual split or a reorder after a word cut losing exact timing on a shot.
  it('keeps exact spans after a manual split and a reorder', async () => {
    const { splitScene, reorderScenes } = await import('./projectsLogic.js');
    const cut = cutScenesOnLyricWords(board([[0, 4]], [0, 2]), { cueIds: ['f'], mode: 'word' }).project;
    const first = cut.scenes.find((s) => s.startSec === 0);
    const split = splitScene(cut, first.sceneId, { atSec: 1 }).project;
    expect(await render(split)).toEqual([1, 1, 2]);
    const ids = split.scenes.map((s) => s.sceneId);
    expect(await render(reorderScenes(split, [ids[1], ids[0], ids[2]]))).toEqual([1, 1, 2]);
  });

  // Catches a hand retime of the last anchored cut handing the board back to natural clip lengths.
  it('keeps exact spans after the last word anchor is retimed away', async () => {
    const cut = cutScenesOnLyricWords(board([[0, 2]], [0.5]), { cueIds: ['f'], mode: 'word' }).project;
    const word = cut.scenes.find((s) => s.lyricAnchor);
    const intro = cut.scenes.find((s) => !s.lyricAnchor);
    let moved = applySceneUpdate(cut, word.sceneId, { startSec: 0.6 }).project;
    moved = applySceneUpdate(moved, intro.sceneId, { endSec: 0.6 }).project;
    expect(moved.scenes.some((s) => s.lyricAnchor)).toBe(false);
    expect(await render(moved)).toEqual([0.6, 1.4]);
  });
});
