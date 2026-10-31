import { describe, expect, it } from 'vitest';
import { storyboardFitSong, storyboardPanelRev } from './storyboardFit.js';
import { storyboardPanelSpans, storyboardShotSyncPlan } from './storyboardShotSync.js';

const panel = (id, seconds, action = `Panel ${id}`, extra = {}) => ({
  id: `panel-${id}`, action, dialogue: '', framing: null, camera: '', seconds, castIds: [], environmentIds: [], objectIds: [], takes: [], selectedTakeId: null, ...extra,
});
const beat = (id, title, panels, extra = {}) => ({ id: `beat-${id}`, title, what: '', musicalRole: null, panels, ...extra });
const song = storyboardFitSong({
  audioAnalysis: { durationSec: 20, beats: [], downbeats: [], sections: [{ label: 'Verse', startSec: 0, endSec: 10 }, { label: 'Chorus', startSec: 10, endSec: 20 }] },
  lyricCues: [
    { id: 'c1', text: 'First line', startSec: 1, endSec: 3 },
    { id: 'c2', text: 'Hook line', startSec: 12, endSec: 14 },
  ],
});
const board = (panels = [panel('a', 6), panel('b', 6), panel('c', 7.6)]) => ({
  beats: [beat('pre', 'Cold open', [panel('p', 2)], { beforeSong: true }), beat('v', 'Verse', panels.slice(0, 2)), beat('k', 'Chorus', panels.slice(2))],
});
const shot = (id, startSec, endSec, extra = {}) => ({ sceneId: `mvs-${id}`, order: 0, label: id, startSec, endSec, visualIntent: `shot ${id}`, ...extra });

describe('storyboardPanelSpans', () => {
  it('plays the song panels end to end at their own lengths, the last running to the song end', () => {
    const { panels, totalSec, overrunSec, gapSec } = storyboardPanelSpans(board(), song);
    expect(panels.map((s) => [s.panelId, s.beforeSong, s.startSec, s.endSec, s.durationSec])).toEqual([
      ['panel-p', true, null, null, 2], ['panel-a', false, 0, 6], ['panel-b', false, 6, 12], ['panel-c', false, 12, 20],
    ].map((row) => (row.length === 4 ? [...row, row[3] - row[2]] : row)));
    expect(panels[1]).toMatchObject({ lyricText: 'First line', sectionLabel: 'Verse', label: 'Verse · 1/2' });
    expect(panels[3]).toMatchObject({ lyricText: 'Hook line', sectionIndex: 1, sectionLabel: 'Chorus' });
    expect({ totalSec, overrunSec, gapSec }).toEqual({ totalSec: 19.6, overrunSec: 0, gapSec: 0 });
  });

  it('names a gap before the song end and a run past it', () => {
    expect(storyboardPanelSpans(board([panel('a', 3), panel('b', 3), panel('c', 3)]), song)).toMatchObject({ gapSec: 11, overrunSec: 0 });
    const over = storyboardPanelSpans(board([panel('a', 10), panel('b', 10), panel('c', 5)]), song);
    expect(over.overrunSec).toBe(5);
    expect(over.panels.at(-1).pastSong).toBe(true);
  });
});

describe('storyboardShotSyncPlan', () => {
  it('makes a shot per panel when there are none', () => {
    const plan = storyboardShotSyncPlan(board(), { scenes: [] }, { song });
    expect(plan.counts).toMatchObject({ added: 4, linked: 0, removed: 0 });
    expect(plan.shots[0].input).toMatchObject({ preMusic: { durationSec: 2 }, panelId: 'panel-p', visualIntent: 'Panel p' });
    expect(plan.shots[1].input).toMatchObject({ startSec: 0, endSec: 6, lyricText: 'First line', panelId: 'panel-a' });
  });

  it('links unlinked shots by span or by most of it, keeping their words, and removes the rest', () => {
    const scenes = [shot('1', 0, 6), shot('2', 6, 11.8), shot('3', 11.8, 16), shot('4', 16, 20)];
    const plan = storyboardShotSyncPlan(board(), { scenes }, { song });
    const byPanel = Object.fromEntries(plan.shots.map((s) => [s.panelId, s]));
    expect(byPanel['panel-a']).toMatchObject({ sceneId: 'mvs-1', link: 'span', retimed: false });
    expect(byPanel['panel-a'].patch).toMatchObject({ panelId: 'panel-a' });
    expect(byPanel['panel-a'].patch).not.toHaveProperty('visualIntent');
    expect(byPanel['panel-b']).toMatchObject({ sceneId: 'mvs-2', link: 'overlap', retimed: true });
    expect(byPanel['panel-b'].patch).toMatchObject({ endSec: 12 });
    expect(byPanel['panel-c']).toMatchObject({ sceneId: null, link: 'new' });
    expect(byPanel['panel-p'].link).toBe('new');
    expect(plan.removed.map((s) => s.sceneId)).toEqual(['mvs-3', 'mvs-4']);
    expect(plan.inSync).toBe(false);
  });

  it('keeps a linked shot following its panel and is in sync once applied', () => {
    const b = board();
    const linked = (p, startSec, endSec, extra = {}) => shot(p.id, startSec, endSec, {
      panelId: p.id, panelRev: storyboardPanelRev(p), panelArt: null, ...extra,
    });
    const [pre, a, bb, c] = [b.beats[0].panels[0], ...b.beats[1].panels, b.beats[2].panels[0]];
    const spans = storyboardPanelSpans(b, song).panels;
    const scenes = [
      linked(pre, null, null, { order: 0, preMusic: { durationSec: 2 }, label: spans[0].label, sectionIndex: null, sectionLabel: null }),
      ...[a, bb, c].map((p, i) => linked(p, spans[i + 1].startSec, spans[i + 1].endSec, {
        order: i + 1, label: spans[i + 1].label, sectionIndex: spans[i + 1].sectionIndex, sectionLabel: spans[i + 1].sectionLabel, lyricText: spans[i + 1].lyricText,
      })),
    ];
    expect(storyboardShotSyncPlan(b, { scenes }, { song }).inSync).toBe(true);

    // The first panel grows a second: every later shot moves (the last still ends with the song), keeping its own words.
    a.seconds = 7;
    const moved = storyboardShotSyncPlan(b, { scenes }, { song });
    expect(moved.counts).toMatchObject({ retimed: 3, added: 0, removed: 0 });
    expect(moved.shots[3].patch).toMatchObject({ startSec: 13 });
    expect(moved.shots[3].patch).not.toHaveProperty('endSec');
    expect(moved.shots[1].patch).toMatchObject({ endSec: 7 });
    expect(moved.shots[2].patch).toMatchObject({ startSec: 7 });
    expect(moved.shots[2].patch).not.toHaveProperty('visualIntent');

    // A reworded panel rewords its open shot, but a locked shot waits for Update.
    bb.action = 'Reworded';
    const reworded = storyboardShotSyncPlan(b, { scenes }, { song });
    expect(reworded.shots[2]).toMatchObject({ content: true, held: false });
    expect(reworded.shots[2].patch).toMatchObject({ visualIntent: 'Reworded' });
    const held = storyboardShotSyncPlan(b, { scenes }, { song, locks: { [scenes[2].sceneId]: 'locked' } });
    expect(held.shots[2]).toMatchObject({ content: false, held: true });
    expect(held.shots[2].patch).not.toHaveProperty('visualIntent');
    expect(held.counts.held).toBe(1);
  });

  it('never moves a shot whose video is locked, and removes a locked shot only when asked', () => {
    const scenes = [shot('1', 0, 5.5), shot('2', 6, 12), shot('3', 12, 20), shot('x', 20, 20)];
    const clipLocks = { 'mvs-1': 'locked' };
    const locks = { 'mvs-x': 'locked' };
    const plan = storyboardShotSyncPlan(board(), { scenes }, { song, locks, clipLocks });
    expect(plan.shots[1]).toMatchObject({ sceneId: 'mvs-1', retimed: false });
    expect(plan.shots[1].blocked).toMatch(/video is locked/);
    expect(plan.shots[1].patch).not.toHaveProperty('endSec');
    expect(plan.removed).toEqual([expect.objectContaining({ sceneId: 'mvs-x', locked: true, blocked: expect.stringMatching(/locked/) })]);
    const forced = storyboardShotSyncPlan(board(), { scenes }, { song, locks, clipLocks, removeLocked: true });
    expect(forced.removed[0].blocked).toBeNull();
    expect(forced.counts.removed).toBe(1);
  });

  it('refuses a board that runs past the song, or with no song', () => {
    expect(storyboardShotSyncPlan(board([panel('a', 10), panel('b', 10), panel('c', 5)]), { scenes: [] }, { song }).problem).toMatch(/past the end/);
    expect(storyboardShotSyncPlan(board(), { scenes: [] }).problem).toMatch(/Analyze the song/);
  });
});
