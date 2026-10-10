import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-lyric-playthrough-'),
}));

const { lyricScenes, buildLyricPlaythroughPreview } = await import('./lyricPlaythrough.js');

afterAll(() => cleanupTempDataRoots());

const cue = (text, startSec, endSec = startSec == null ? null : startSec + 2) => ({ id: `c-${text}`, text, startSec, endSec });
const portosData = (html) => JSON.parse(/window\.PORTOS_MV = (\{.*?\});window\.PORTOS_MV_EVENT_STATE/s.exec(html)[1]);

describe('lyric scenes', () => {
  it('opens a scene at each sheet section, from 0 to the end of the song', () => {
    const cues = [cue('a', 5), cue('b', 8), cue('c', 20), cue('d', 24), cue('e', 40)];
    const markers = [
      { type: 'section', label: 'Verse 1', line: 1 },
      { type: 'direction', label: 'Whispered', line: 2 },
      { type: 'section', label: 'Chorus', line: 2 },
      { type: 'section', label: 'Outro', line: 5 },
    ];
    expect(lyricScenes(cues, markers, 60).map(({ label, startSec, endSec }) => [label, startSec, endSec])).toEqual([
      ['Intro', 0, 8], ['Verse 1', 8, 20], ['Chorus', 20, 60],
    ]);
  });

  it('groups four lines a scene without headers and skips a group with no timed line', () => {
    const cues = [cue('a', 2), cue('b', 4), cue('c', 6), cue('d', 8), cue('e', null), cue('f', null), cue('g', 30)];
    expect(lyricScenes(cues, [], 50).map(({ label, startSec, endSec }) => [label, startSec, endSec])).toEqual([
      ['Lines 1–4', 0, 30], ['Lines 5–7', 30, 50],
    ]);
  });
});

describe('lyric timing playthrough', () => {
  const project = {
    id: 'mv-example', name: 'Example Song', audioAnalysis: { durationSec: 30, bpm: 120, sections: [] },
    lyricCues: [
      { ...cue('hello there', 2), words: [{ text: 'hello', startSec: 2, endSec: 2.5 }, { text: 'there', startSec: 2.6, endSec: 3.4 }] },
      cue('second line', 10),
    ],
    lyricMarkers: [{ type: 'section', label: 'Chorus', line: 1 }],
    scenes: [],
    composition: { mode: 'document', textCues: [{ text: 'Overlay', startSec: 0, endSec: 5 }], overlay: { enabled: true } },
  };

  it('needs the analysis and at least one timed line', async () => {
    await expect(buildLyricPlaythroughPreview({ ...project, audioAnalysis: null })).rejects.toMatchObject({ status: 409, code: 'NOT_ANALYZED' });
    await expect(buildLyricPlaythroughPreview({ ...project, lyricCues: [cue('untimed', null)] })).rejects.toMatchObject({ status: 409, code: 'NO_TIMED_LYRICS' });
  });

  it('draws the aligned words with the shipped template over the lyrics laid out as scenes, with no project document', async () => {
    const preview = await buildLyricPlaythroughPreview(project);
    const data = portosData(preview.html);
    expect(data.scenes.map(({ label, startSec, endSec, media }) => [label, startSec, endSec, media])).toEqual([
      ['Intro', 0, 10, null], ['Chorus', 10, 30, null],
    ]);
    expect(data.lyrics.map((line) => line.text)).toEqual(['hello there', 'second line']);
    // Only the words: no overlay text or HUD from the project's own composition.
    expect(data.textCues).toEqual([]);
    expect(data.composition.overlay).toBeNull();
    expect(preview.html).toContain('data:text/javascript;base64,');
    expect(preview.assets).toEqual([]);
    expect(preview.durationSec).toBeGreaterThan(29);
  });

  it('follows the board\'s timed shots, without their takes, once there are any', async () => {
    const scenes = [
      { sceneId: 's1', order: 0, label: 'Wide', startSec: 0, endSec: 12, textZone: 'upper-right', referenceImageId: 'frame.png', videoHistoryId: 'v1' },
      { sceneId: 's2', order: 1, label: 'Close', startSec: 12, endSec: 30, textZone: 'lower' },
    ];
    const data = portosData((await buildLyricPlaythroughPreview({ ...project, scenes })).html);
    expect(data.scenes.map(({ sceneId, textZone, media }) => [sceneId, textZone, media])).toEqual([['s1', 'upper-right', null], ['s2', 'lower', null]]);
  });
});
