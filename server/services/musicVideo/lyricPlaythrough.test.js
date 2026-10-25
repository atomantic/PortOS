import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-lyric-playthrough-'),
}));

const { buildLyricPlaythroughPreview, lyricOverlayDocumentData } = await import('./lyricPlaythrough.js');

afterAll(() => cleanupTempDataRoots());

const cue = (text, startSec, endSec = startSec == null ? null : startSec + 2) => ({ id: `c-${text}`, text, startSec, endSec });
const portosData = (html) => JSON.parse(/window\.PORTOS_MV = (\{.*?\});window\.PORTOS_MV_EVENT_STATE/s.exec(html)[1]);
// The scenes the playthrough lays out for these lyrics, as [label, startSec, endSec].
const lyricScenes = async (lyricCues, lyricMarkers, durationSec) => portosData((await buildLyricPlaythroughPreview({
  id: 'mv-example', name: 'Example Song', audioAnalysis: { durationSec }, lyricCues, lyricMarkers, scenes: [],
})).html).scenes.map(({ label, startSec, endSec }) => [label, startSec, endSec]);

describe('lyric scenes', () => {
  it('opens a scene at each sheet section, from 0 to the end of the song', async () => {
    const cues = [cue('a', 5), cue('b', 8), cue('c', 20), cue('d', 24), cue('e', 40)];
    const markers = [
      { type: 'section', label: 'Verse 1', line: 1 },
      { type: 'direction', label: 'Whispered', line: 2 },
      { type: 'section', label: 'Chorus', line: 2 },
      { type: 'section', label: 'Outro', line: 5 },
    ];
    expect(await lyricScenes(cues, markers, 60)).toEqual([
      ['Intro', 0, 8], ['Verse 1', 8, 20], ['Chorus', 20, 60],
    ]);
  });

  it('groups four lines a scene without headers and skips a group with no timed line', async () => {
    const cues = [cue('a', 2), cue('b', 4), cue('c', 6), cue('d', 8), cue('e', null), cue('f', null), cue('g', 30)];
    expect(await lyricScenes(cues, [], 50)).toEqual([
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

  it('shows the timing check when picture overlays are off, but keeps the picture overlay off', async () => {
    const hidden = { ...project, lyricOverlayEnabled: false };
    const check = portosData((await buildLyricPlaythroughPreview(hidden)).html);
    const picture = portosData((await buildLyricPlaythroughPreview(hidden, { overlay: true })).html);
    expect(check.composition.lyricOverlayEnabled).toBe(true);
    expect(picture.composition.lyricOverlayEnabled).toBe(false);
    expect(check.lyrics).toEqual(picture.lyrics);
    expect(hidden.lyricCues).toEqual(project.lyricCues);
  });

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

  it('draws the same words alone on a transparent page for the storyboard animatic', async () => {
    const scenes = [{ sceneId: 's1', order: 0, label: 'Wide', startSec: 0, endSec: 30, textZone: 'upper-right', referenceImageId: 'frame.png' }];
    const filmLook = { preset: 'vhs', enabled: true };
    const titleCard = { enabled: true, title: 'Example Song' };
    const preview = await buildLyricPlaythroughPreview({ ...project, scenes, filmLook, titleCard }, { overlay: true });
    const data = portosData(preview.html);
    expect(data.lyrics.map((line) => line.text)).toEqual(['hello there', 'second line']);
    expect(data.scenes.map(({ sceneId, textZone, media }) => [sceneId, textZone, media])).toEqual([['s1', 'upper-right', null]]);
    // The frames stay in the PortOS page: the overlay is transparent and bridges no media.
    expect(preview.html).toMatch(/background: transparent/);
    expect(preview.html).not.toContain('Layered music-video composition');
    expect(preview.assets).toEqual([]);
    // The project's film look would filter (and dim) the whole transparent page.
    expect(preview.html).toContain('let look = null;');
    // The opening title card does ride along, so it can be checked against the lyrics and the animatic.
    expect(preview.html).toContain('"title":"Example Song"');
  });
});

describe('lyric overlay for a composed render', () => {
  it('keeps a title card shot\'s sung line off the overlay, since the card already draws it', () => {
    const data = lyricOverlayDocumentData({
      audioAnalysis: { durationSec: 10 }, lyricCues: [cue('found a shot', 1), cue('then changed the scene', 5)],
      scenes: [
        { sceneId: 's1', order: 0, startSec: 0, endSec: 4, visualLayer: 'card', lyricText: 'found a shot', textZone: 'upper' },
        { sceneId: 's2', order: 1, startSec: 4, endSec: 10, textZone: 'upper-right' },
      ],
    }, { width: 320, height: 180, fps: 24, durationSec: 10 });
    expect(data.scenes.map((scene) => [scene.sceneId, scene.textZone])).toEqual([['s1', 'none'], ['s2', 'upper-right']]);
    expect(data.render).toMatchObject({ width: 320, height: 180, fps: 24 });
  });
});
